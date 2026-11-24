import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readJson, writeJsonAtomic, singleFlight } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

test('writeJsonAtomic não deixa temporários e readJson tolera arquivo corrompido/ausente', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ollyx-cache-'));
  const file = join(dir, 'sub', 'a.json');
  await writeJsonAtomic(file, { ok: 1 });
  assert.deepEqual(await readJson(file), { ok: 1 });
  assert.deepEqual(await readdir(join(dir, 'sub')), ['a.json']);
  await writeFile(file, '{"cortado":');
  assert.equal(await readJson(file), null);
  assert.equal(await readJson(join(dir, 'nao-existe.json')), null);
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(file, { i }))); // escritas concorrentes
  assert.equal(typeof (await readJson(file)).i, 'number');
  assert.deepEqual(await readdir(join(dir, 'sub')), ['a.json']);
});

test('singleFlight junta chamadas iguais e simultâneas, mas não chamadas posteriores', async () => {
  const flight = singleFlight();
  let runs = 0;
  const work = () => new Promise(r => setTimeout(() => r(++runs), 20));
  const [a, b] = await Promise.all([flight('k', work), flight('k', work)]);
  assert.equal(a, b); assert.equal(runs, 1);
  await flight('k', work); assert.equal(runs, 2);
  const failing = () => Promise.reject(new Error('x'));
  await assert.rejects(flight('f', failing)); await assert.rejects(flight('f', failing)); // erro não fica preso
});

test('dataDir: padrão fora do pacote, OLLYX_DATA_DIR sobrescreve e vazio cai no padrão', () => {
  assert.equal(loadConfig({}, false).dataDir, join(homedir(), '.ollyx'));
  assert.equal(loadConfig({ OLLYX_DATA_DIR: '  ' }, false).dataDir, join(homedir(), '.ollyx'));
  assert.equal(loadConfig({ OLLYX_DATA_DIR: 'dados' }, false).dataDir, resolve('dados'));
});

async function connect(client) {
  const config = loadConfig({ BLING_ACCESS_TOKEN: 't', MELI_ACCESS_TOKEN: 't', OLLYX_DATA_DIR: await mkdtemp(join(tmpdir(), 'ollyx-data-')) }, false);
  const server = createServer({ config, tokens: { source: async () => 'environment', get: async () => 't' }, client: client.api });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 't', version: '1' });
  await mcp.connect(b);
  return { mcp, config };
}

test('ollyx_status verificar=true testa escopos e marca falhas sem vazar detalhes', async () => {
  const api = { async query(provider, path) {
    if (path === '/pedidos/vendas') { const e = new Error('x'); e.code = 'scope_denied'; e.extra = { status: 403 }; throw Object.assign(e, { name: 'OllyxError' }); }
    return { data: path === '/users/me' ? { id: 9 } : {} };
  } };
  const { mcp } = await connect({ api });
  const plain = (await mcp.callTool({ name: 'ollyx_status', arguments: {} })).structuredContent;
  assert.equal(plain.remotePermissionsVerified, false);
  assert.equal(plain.testes, undefined);
  const checked = (await mcp.callTool({ name: 'ollyx_status', arguments: { verificar: true } })).structuredContent;
  assert.equal(checked.testes.length, 5);
  assert.equal(checked.testes.find(t => t.teste === 'bling /pedidos/vendas').ok, false);
  assert.equal(checked.remotePermissionsVerified, false); // um escopo negado => não verificado
  assert.equal(checked.testes.filter(t => t.ok).length, 4);
});

test('ollyx_depara_sku e ollyx_curva_abc enviam progresso quando o cliente pede', async () => {
  const lista = [{ id: 1, codigo: 'UN', formato: 'S', precoCusto: 1, situacao: 'A', estoque: {} }, { id: 2, codigo: 'KIT', formato: 'E', precoCusto: 2, situacao: 'A', estoque: {} }];
  const api = { async query(_, path, params) {
    if (path === '/produtos') return { data: { data: params.pagina === 1 ? lista : [] } };
    if (path.startsWith('/produtos/estruturas/')) return { data: { data: { componentes: [{ produto: { id: 1 }, quantidade: 2 }] } } };
    throw new Error('inesperado ' + path);
  } };
  const { mcp } = await connect({ api });
  const events = [];
  const res = await mcp.callTool({ name: 'ollyx_depara_sku', arguments: { skus: ['KIT'] } }, undefined, { onprogress: p => events.push(p) });
  assert.equal(res.structuredContent.linhas[0].componentes[0].sku, 'UN');
  assert.ok(events.length >= 1 && events.every(e => e.total === 1));
  const silent = await mcp.callTool({ name: 'ollyx_depara_sku', arguments: { atualizar: true } });
  assert.equal(silent.isError, undefined); // sem progressToken: funciona igual
});

test('Mercado Livre aceita ML_CLIENT_* como alternativa; MELI_* tem prioridade; Bling não é afetado', () => {
  const a = loadConfig({ ML_CLIENT_ID: 'id-ml', ML_CLIENT_SECRET: 'sec-ml' }, false).providers;
  assert.deepEqual([a.meli.clientId, a.meli.clientSecret, a.bling.clientId], ['id-ml', 'sec-ml', '']);
  const b = loadConfig({ ML_CLIENT_ID: 'id-ml', MELI_CLIENT_ID: 'id-meli', BLING_CLIENT_ID: 'id-bling' }, false).providers;
  assert.deepEqual([b.meli.clientId, b.bling.clientId], ['id-meli', 'id-bling']);
});

test('assistente da connection string: senha com @ / # é recodificada; erros comuns são recusados', async () => {
  const { parseConnectionString } = await import('../scripts/set-database-url.mjs');
  const c = parseConnectionString('postgresql://postgres.ref:p@ss/w#rd@aws-0-us-west-2.pooler.supabase.com:6543/postgres');
  assert.deepEqual([c.host, c.port, c.user, c.password], ['aws-0-us-west-2.pooler.supabase.com', 6543, 'postgres.ref', 'p@ss/w#rd']);
  assert.equal(c.url, 'postgresql://postgres.ref:p%40ss%2Fw%23rd@aws-0-us-west-2.pooler.supabase.com:6543/postgres');
  assert.equal(parseConnectionString(c.url).password, 'p@ss/w#rd'); // idempotente
  assert.throws(() => parseConnectionString('postgresql://u:[YOUR-PASSWORD]@h.pooler.supabase.com:6543/postgres'), /YOUR-PASSWORD/);
  assert.throws(() => parseConnectionString('postgresql://u:p@base/postgres'), /não parece um endereço/);
  assert.throws(() => parseConnectionString('texto qualquer'), /postgresql:\/\//);
});

test('purge:ml apaga cópias de pedidos, exportações e a conexão do ML, e nada do Bling', async () => {
  const { run } = await import('../scripts/remote-admin.js');
  const sqls = [];
  const pool = { query: async text => { sqls.push(text); return { rowCount: /mcp\.kv/.test(text) ? 12 : 1, rows: [] }; } };
  const out = [];
  await run(['purge:ml'], pool, l => out.push(l));
  assert.equal(sqls.length, 2);
  assert.match(sqls[0], /DELETE FROM mcp\.kv WHERE key LIKE 'orders2-%' OR key LIKE 'export\.%'/);
  assert.match(sqls[1], /DELETE FROM mcp\.provider_tokens WHERE provider = 'meli'/);
  assert.equal(sqls.some(q => /bling/i.test(q) && !/provider = 'meli'/.test(q)), false);
  assert.match(out[0], /12 cópia\(s\).*1 conexão/);
});
