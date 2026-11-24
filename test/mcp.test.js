import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

test('handshake real por stdio: lista ferramentas, recursos e consulta status sem credenciais', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
    env: { ...process.env, BLING_ACCESS_TOKEN: '', MELI_ACCESS_TOKEN: '', BLING_USE_OLLYX_DATABASE: 'false', MELI_USE_OLLYX_DATABASE: 'false' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ollyx-integration-test', version: '1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['ollyx_consultar', 'ollyx_consultar_paginas', 'ollyx_curva_abc', 'ollyx_depara_sku', 'ollyx_recursos', 'ollyx_status']);
    for (const tool of tools.tools) {
      // ollyx_curva_abc grava só cache/CSV locais; nenhuma ferramenta escreve nas APIs.
      assert.equal(tool.annotations.readOnlyHint, !['ollyx_curva_abc', 'ollyx_depara_sku'].includes(tool.name));
      assert.equal(tool.annotations.destructiveHint, false);
    }
    const status = await client.callTool({ name: 'ollyx_status', arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.mode, 'read_only');
    assert.equal(status.structuredContent.remotePermissionsVerified, false);
    const resources = await client.listResources();
    assert.equal(resources.resources[0].uri, 'ollyx://overview');
    const overview = await client.readResource({ uri: 'ollyx://overview' });
    assert.match(overview.contents[0].text, /GET/);
    const catalog = await client.callTool({ name: 'ollyx_recursos', arguments: { provider: 'bling', search: 'estoque' } });
    assert.ok(catalog.structuredContent.total > 0);
    const bad = await client.callTool({ name: 'ollyx_consultar', arguments: { provider: 'meli', path: 'https://evil.test' } });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.code, 'invalid_path');
  } finally { await client.close(); }
});
test('chamada MCP passa filtros/versões e retorna dados com cliente simulado', async () => {
  const config = loadConfig({}, false);
  let received;
  const server = createServer({
    config, tokens: { source: async () => 'mock' },
    client: { query: async (...args) => { received = args; return { data: { id: 123 } }; } },
  });
  const client = new Client({ name: 'ollyx-memory-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const result = await client.callTool({ name: 'ollyx_consultar', arguments: {
      provider: 'meli', path: '/orders/123', params: { seller: 456 }, headers: { 'x-new-domain': 'true' },
    } });
    assert.equal(result.structuredContent.data.id, 123);
    assert.deepEqual(received, ['meli', '/orders/123', { seller: 456 }, { 'x-new-domain': 'true' }]);
  } finally { await client.close(); await server.close(); }
});

test('MCP protege contatos antes da projeção e bloqueia documentos opacos', async () => {
  const server = createServer({ config: loadConfig({}, false), tokens: { source: async () => 'mock' },
    client: { query: async (_provider, path) => path === '/contatos'
      ? { data: { data: [{ id: 1, nome: 'Pessoa privada de teste', numeroDocumento: '000' }] } }
      : { contentType: 'application/pdf', data: { encoding: 'base64', content: 'UFJJVkFURQ==' } },
    },
  });
  const client = new Client({ name: 'privacy', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const contact = await client.callTool({ name: 'ollyx_consultar', arguments: { provider: 'bling', path: '/contatos', campos: ['nome'] } });
    assert.equal(contact.structuredContent.data.data[0].nome, '[OCULTO]');
    const document = await client.callTool({ name: 'ollyx_consultar', arguments: { provider: 'meli', path: '/shipment_labels', campos: ['content'] } });
    assert.equal(document.isError, true);
    assert.equal(document.structuredContent.error.code, 'unsupported_response_format');
    assert.equal(JSON.stringify(document).includes('UFJJVkFURQ=='), false);
  } finally { await client.close(); await server.close(); }
});

test('esquemas das ferramentas são JSON Schema moderno (o ChatGPT recusa a lista inteira se houver tupla antiga)', async () => {
  const server = createServer({ config: loadConfig({ BLING_ACCESS_TOKEN: 't', MELI_ACCESS_TOKEN: 't' }, false) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'schemas', version: '1' });
  await client.connect(b);
  const { tools } = await client.listTools();
  const problems = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.items)) problems.push(`${path}: "items" é uma lista (tupla antiga); use um esquema único`);
    if ('additionalItems' in node) problems.push(`${path}: "additionalItems" não existe no JSON Schema moderno`);
    if (node.type === 'array' && (node.items === undefined || (typeof node.items === 'object' && !Object.keys(node.items).length))) problems.push(`${path}: array sem tipo de itens`);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
  };
  for (const t of tools) { walk(t.inputSchema, t.name); assert.ok(t.description.length < 1024, `${t.name}: descrição longa demais`); }
  assert.deepEqual(problems, []);
  const cortes = tools.find(t => t.name === 'ollyx_curva_abc').inputSchema.properties.cortes;
  assert.deepEqual([cortes.type, cortes.items.type, cortes.minItems, cortes.maxItems], ['array', 'number', 2, 2]);
  await client.close();
});
