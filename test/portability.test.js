import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { clientConfigs, generateConfigs } from '../scripts/generate-config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
async function withTemp(action) {
  const temp = await mkdtemp(join(process.env.OLLYX_TEST_TEMP || tmpdir(), 'ollyx-portable-'));
  try { return await action(temp); } finally { await rm(temp, { recursive: true, force: true }); }
}
test('arquivo externo ancora tokens e fontes na pasta dele, independente do cwd', () => withTemp(async temp => {
  const file = join(temp, '.env');
  await writeFile(file, 'BLING_TOKEN_FILE=oauth/bling.json\nMELI_SHARED_ENV_FILE=integracao/.env\n');
  const c = loadConfig({ OLLYX_CONFIG_FILE: file });
  assert.equal(c.providers.bling.tokenFile, resolve(temp, 'oauth/bling.json'));
  assert.equal(c.providers.meli.sharedEnvFile, resolve(temp, 'integracao/.env'));
}));
test('variáveis do cliente têm prioridade sobre o arquivo de conexão', () => withTemp(async temp => {
  const file = join(temp, '.env');
  await writeFile(file, 'BLING_ACCESS_TOKEN=file-test-token\n');
  const c = loadConfig({ OLLYX_CONFIG_FILE: file, BLING_ACCESS_TOKEN: 'client-test-token' });
  assert.equal(c.providers.bling.accessToken, 'client-test-token');
}));
test('arquivo externo ausente resulta em erro claro sem fallback para conexão deste PC', () => withTemp(async temp => {
  assert.throws(() => loadConfig({ OLLYX_CONFIG_FILE: join(temp, 'missing.env') }), { code: 'invalid_config_file' });
}));
test('configuração Claude aceita espaços e caminhos Windows sem campos extras de outros clientes', () => {
  const c = clientConfigs('D:\\Outro PC\\Ollyx', 'C:\\Program Files\\nodejs\\node.exe', 'D:\\Dados privados\\.env');
  assert.deepEqual(Object.keys(c.claude.mcpServers.ollyx).sort(), ['args', 'command', 'env']);
  assert.deepEqual(c.claude.mcpServers.ollyx.args, ['D:/Outro PC/Ollyx/src/server.js']);
  assert.equal(c.claude.mcpServers.ollyx.env.OLLYX_CONFIG_FILE, 'D:/Dados privados/.env');
});
test('gerador também aceita caminhos Unix/macOS e não inclui credenciais', () => {
  const c = clientConfigs('/Users/demo/Ollyx', '/usr/local/bin/node');
  assert.equal(c.claude.mcpServers.ollyx.args[0], '/Users/demo/Ollyx/src/server.js');
  assert.equal(c.claude.mcpServers.ollyx.env, undefined);
  assert.equal(JSON.stringify(c).includes('ACCESS_TOKEN'), false);
});
test('geração em uma pasta nova não carrega configuração da máquina original', () => withTemp(async temp => {
  await generateConfigs({ root: '/new-machine/Ollyx', command: '/usr/bin/node', outputDir: pathToFileURL(temp + '/') });
  const generated = JSON.parse(await readFile(join(temp, 'claude_desktop_config.json'), 'utf8'));
  assert.equal(generated.mcpServers.ollyx.args[0], '/new-machine/Ollyx/src/server.js');
  assert.equal(JSON.stringify(generated).includes('C:/Users/User'), false);
}));
test('manifesto tem caminhos relocáveis e campos sensíveis sem valores embutidos', async () => {
  const m = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(m.server.entry_point, 'src/desktop.js');
  assert.equal(m.server.mcp_config.args[0], '\${__dirname}/src/desktop.js');
  assert.equal(m.user_config.bling_access_token.sensitive, true);
  assert.equal(m.user_config.meli_access_token.sensitive, true);
  assert.equal(m.user_config.bling_access_token.default, '');
  assert.equal(m.user_config.settings_file.type, 'file');
});
test('entrypoint Claude faz handshake com arquivo externo e campos opcionais vazios', () => withTemp(async temp => {
  const file = join(temp, '.env');
  await writeFile(file, 'BLING_ACCESS_TOKEN=portable-test-only-token\n');
  const client = new Client({ name: 'claude-portable-test', version: '1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/desktop.js', import.meta.url))],
    env: { ...process.env, OLLYX_CONFIG_FILE: file, BLING_ACCESS_TOKEN: '', MELI_ACCESS_TOKEN: '' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const manifestTools = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8')).tools.map(t => t.name).sort();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), manifestTools); // manifesto e servidor nunca divergem
    const status = (await client.callTool({ name: 'ollyx_status', arguments: {} })).structuredContent;
    assert.equal(status.integrations.find(p => p.provider === 'bling').credentialSource, 'environment');
    assert.equal(JSON.stringify(status).includes('portable-test-only-token'), false);
    assert.equal(status.mode, 'read_only');
  } finally { await client.close(); }
}));
