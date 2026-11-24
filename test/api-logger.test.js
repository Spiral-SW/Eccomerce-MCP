import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { apiLogFile, createApiLogger, readApiLogs, safeEndpoint } from '../src/api-logger.js';

const config = () => loadConfig({}, false);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function capture() {
  const lines = [];
  return { lines, logger: createApiLogger({ write: line => lines.push(JSON.parse(line)) }) };
}

test('logs registram cada tentativa e correlacionam a renovação sem registrar credenciais ou respostas', async () => {
  const { lines, logger } = capture();
  let calls = 0;
  const api = new ApiClient(config(), { get: async () => 'sensitive-access-token' }, {
    logger, sleep: async () => {}, fetchImpl: async () => ++calls === 1 ? json({}, 401)
      : json({ buyer: { email: 'private@example.test' } }),
  });
  await api.query('meli', '/orders/123456789', { q: 'sensitive-search-value' });
  assert.deepEqual(lines.map(line => line.status), [401, 200]);
  assert.deepEqual(lines.map(line => line.attempt), [1, 2]);
  assert.equal(lines[0].requestId, lines[1].requestId);
  assert.equal(lines[0].endpoint, '/orders/{order_id}');
  assert.ok(lines.every(line => line.durationMs >= 0 && line.method === 'GET'));
  for (const secret of ['sensitive-access-token', 'private@example.test', '123456789', 'sensitive-search-value']) {
    assert.equal(JSON.stringify(lines).includes(secret), false);
  }
});

test('erros de validação, rede e resposta ficam explícitos, sem ecoar mensagens privadas', async () => {
  for (const [fetchImpl, path, expected] of [
    [async () => { throw new Error('private-network-secret'); }, '/orders/1', 'network_error'],
    [async () => json({ secret: 'private-body-secret' }, 403), '/orders/1', 'scope_denied'],
    [async () => new Response('{', { headers: { 'content-type': 'application/json' } }), '/orders/1', 'invalid_response'],
    [async () => { throw new Error('must not fetch'); }, 'https://private-invalid-secret', 'invalid_path'],
  ]) {
    const { lines, logger } = capture();
    const api = new ApiClient(config(), { get: async () => 'token' }, { fetchImpl, logger });
    await assert.rejects(api.query('meli', path), { code: expected });
    assert.equal(lines.at(-1).event, 'api_error');
    assert.equal(lines.at(-1).error, expected);
    assert.equal(JSON.stringify(lines).includes('private-'), false);
  }
});

test('cauda do JSONL é limitada e falhas de escrita não impedem consultas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ollyx-api-log-'));
  const date = new Date('2026-11-24T12:00:00Z');
  try {
    const logger = createApiLogger({ directory, now: () => date, write: () => {} });
    for (let i = 1; i <= 25; i++) logger.record({ provider: 'bling', path: '/produtos', status: 200, attempt: i });
    await logger.flush();
    assert.equal((await readFile(apiLogFile(directory, date), 'utf8')).trim().split('\n').length, 25);
    assert.deepEqual((await readApiLogs(directory, 2, date)).map(line => line.attempt), [24, 25]);
    assert.deepEqual(await readApiLogs(directory, 5, new Date('2026-11-25')), []);
    await assert.rejects(readApiLogs(directory, 201), /1 a 200/);
    const blocked = join(directory, 'file');
    await writeFile(blocked, 'not a directory');
    const warnings = [];
    const broken = createApiLogger({ directory: blocked, write: line => warnings.push(line) });
    const api = new ApiClient(config(), { get: async () => 'token' }, { logger: broken, fetchImpl: async () => json({ ok: true }) });
    assert.equal((await api.query('bling', '/produtos')).status, 200);
    await broken.flush();
    assert.ok(warnings.some(line => line.includes('api_log_unavailable')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('log desativado não grava; rotas desconhecidas e texto arbitrário nunca vazam', async () => {
  const logger = createApiLogger({ enabled: false, write: () => { throw new Error('should not write'); } });
  logger.record({ provider: 'meli', path: '/orders/secret' });
  await logger.flush();
  assert.equal(safeEndpoint('meli', '/custom/private-secret'), '/unlisted');
  assert.equal(safeEndpoint('bling', '/pedidos/vendas/123'), '/pedidos/vendas/{idPedidoVenda}');
  assert.equal(safeEndpoint('meli', 'https://example.test/private'), '/unlisted');
});
