import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function clientConfigs(root, nodeExecutable, configFile = '') {
  const normalize = value => value.replace(/\\/g, '/').replace(/\/$/, '');
  root = normalize(root);
  const command = normalize(nodeExecutable);
  const args = [root + '/src/server.js'];
  const env = configFile ? { OLLYX_CONFIG_FILE: normalize(configFile) } : undefined;
  const local = { command, args, ...(env ? { env } : {}) };
  return {
    claude: { mcpServers: { ollyx: local } },
    generic: { mcpServers: { ollyx: { type: 'stdio', ...local } } },
    codex: [
      '# Acrescente esta tabela sem substituir o restante do config.toml.',
      '[mcp_servers.ollyx]',
      'command = ' + JSON.stringify(command),
      'args = ' + JSON.stringify(args),
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 180',
      ...(env ? ['', '[mcp_servers.ollyx.env]', 'OLLYX_CONFIG_FILE = ' + JSON.stringify(env.OLLYX_CONFIG_FILE)] : []),
      '',
    ].join('\n'),
  };
}
export async function generateConfigs({ root = fileURLToPath(new URL('../', import.meta.url)), command = process.execPath, configFile = '', outputDir = new URL('../config/', import.meta.url) } = {}) {
  const configs = clientConfigs(root, command, configFile);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(new URL('mcp.json', outputDir), JSON.stringify(configs.generic, null, 2) + '\n'),
    writeFile(new URL('claude_desktop_config.json', outputDir), JSON.stringify(configs.claude, null, 2) + '\n'),
    writeFile(new URL('codex.toml', outputDir), configs.codex),
  ]);
  return configs;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateConfigs({ configFile: process.env.OLLYX_CONFIG_FILE || '' });
  console.log('Configurações geradas em config/. Nenhum cliente foi alterado.');
}
