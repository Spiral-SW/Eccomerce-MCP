import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Analytics, CACHE_TTL_MS, CACHE_MAX_AGE_MS } from '../src/analytics.js';
import { FileStore } from '../src/store.js';
import { PgTokenManager, encrypt } from '../src/remote/provider-tokens.js';
import { ApiClient } from '../src/client.js';

const order = (sku, qty = 1) => ({ status: 'paid', order_items: [{ quantity: qty, unit_price: 10, item: { id: 'M' + sku, title: 't', seller_sku: sku } }] });

test('curva ABC: cache lido em UMA consulta e no máximo 3 dias buscados ao mesmo tempo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ollyx-perf-'));
  const store = new FileStore(dir);
  const calls = { get: 0, getMany: 0 };
  const spy = { get: k => { calls.get++; return store.get(k); }, getMany: k => { calls.getMany++; return store.getMany(k); }, set: (k, v) => store.set(k, v), putExport: (n, t) => store.putExport(n, t) };
  let inFlight = 0, maxInFlight = 0, orderCalls = 0;
  const client = { async query(_, path, params) {
    if (path === '/users/me') return { data: { id: 7 } };
    orderCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 15));
    inFlight--;
    return { data: { results: [order('A')], paging: { total: 1, offset: params.offset, limit: params.limit } } };
  } };
  const now = () => Date.parse('2026-11-06T15:00:00Z');
  const a = new Analytics(client, { store: spy, now });
  const first = await a.curvaAbc({ dias: 9, custos: false });
  assert.equal(first.complete, true);
  assert.equal(first.diasProcessados, 9);
  assert.equal(orderCalls, 9);
  assert.ok(maxInFlight > 1 && maxInFlight <= 3, 'paralelismo entre 2 e 3, foi ' + maxInFlight);
  assert.equal(calls.getMany, 1);
  assert.equal(calls.get, 0); // nada de uma leitura por dia
  orderCalls = 0;
  const second = await new Analytics(client, { store: spy, now }).curvaAbc({ dias: 9, custos: false });
  assert.equal(second.diasDoCache, 8); // hoje nunca vai para o cache
  assert.equal(orderCalls, 1);
  assert.equal(calls.getMany, 2);
});

test('PgTokenManager: token em memória evita idas ao banco; token recusado e expiração voltam ao banco', async () => {
  const key = randomBytes(32);
  let now = 1_700_000_000_000, reads = 0;
  const row = { access_token_enc: encrypt('ACESSO', key), refresh_token_enc: encrypt('REFRESH', key), expires_at: String(now + 3600e3) };
  const pool = { query: async text => { if (/FROM mcp.provider_tokens/.test(text)) { reads++; return { rows: [row] }; } return { rows: [] }; } };
  const tm = new PgTokenManager({ providers: { bling: {} }, timeoutMs: 1000 }, { pool, store: { withLock: async (_, fn) => fn() }, key, now: () => now });
  for (let i = 0; i < 20; i++) assert.equal(await tm.get('bling'), 'ACESSO');
  assert.equal(reads, 1); // 20 chamadas, 1 leitura
  now += 31000; // passou a janela de 30 s
  assert.equal(await tm.get('bling'), 'ACESSO');
  assert.equal(reads, 2);
  const before = reads;
  await assert.rejects(tm.get('bling', 'ACESSO'), e => e.code === 'reconnect_required'); // recusado: ignora a memória e vai ao banco
  assert.ok(reads > before);
});

test('ApiClient conta chamadas externas e tempo (base do registro por ferramenta)', async () => {
  let t = 0;
  const fetchImpl = async () => { t += 40; return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const client = new ApiClient({ timeoutMs: 1000, maxResponseBytes: 1e6, providers: { meli: {}, bling: {} } }, { get: async () => 'tok' }, { fetchImpl, sleep: async () => {}, now: () => t });
  assert.deepEqual(client.stats, { calls: 0, ms: 0 });
  await client.query('meli', '/users/me');
  await client.query('meli', '/users/me');
  assert.equal(client.stats.calls, 2);
  assert.ok(client.stats.ms >= 80);
});

test('PgTokenManager.refreshNow renova mesmo com o token válido e atualiza o banco e a memória', async () => {
  const key = randomBytes(32);
  let now = 1_700_000_000_000, refreshes = 0;
  const stored = { access: 'ANTIGO', refresh: 'R1', expires_at: now + 3600e3 };
  const pool = { query: async (text, params) => {
    if (/FROM mcp.provider_tokens/.test(text)) return { rows: [{ access_token_enc: encrypt(stored.access, key), refresh_token_enc: encrypt(stored.refresh, key), expires_at: String(stored.expires_at) }] };
    if (/INSERT INTO mcp.provider_tokens/.test(text)) { stored.expires_at = Number(params[3]); stored.access = 'NOVO-' + (++refreshes); stored.refresh = 'R' + (refreshes + 1); }
    return { rows: [] };
  } };
  const fetchImpl = async () => { const buf = Buffer.from(JSON.stringify({ access_token: 'NOVO', refresh_token: 'RNOVO', expires_in: 7200 })); return { ok: true, status: 200, headers: new Headers({ 'content-length': String(buf.length) }), body: new Response(buf).body }; };
  const tm = new PgTokenManager({ providers: { bling: { clientId: 'i', clientSecret: 's' } }, timeoutMs: 1000 }, { pool, store: { withLock: async (_, fn) => fn() }, key, fetchImpl, now: () => now });
  assert.equal(await tm.get('bling'), 'ANTIGO'); // válido: sem renovar
  assert.equal(refreshes, 0);
  assert.equal(await tm.refreshNow('bling'), 'renovado');
  assert.equal(refreshes, 1); // renovou mesmo com 1 h de validade
  assert.equal(await tm.get('bling'), 'NOVO');
  const empty = new PgTokenManager({ providers: { meli: {} } }, { pool: { query: async () => ({ rows: [] }) }, store: { withLock: async (_, fn) => fn() }, key });
  assert.equal(await empty.refreshNow('meli'), 'not_configured');
});

test('cache de pedidos (cláusulas 2.2.1.3 e 5.3): vale 24 h, cópia velha ou sem data é relida, renovar ignora o cache, banco recebe validade', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ollyx-ttl-'));
  const store = new FileStore(dir);
  const sets = [];
  const spy = { get: k => store.get(k), getMany: k => store.getMany(k), set: (k, v, o) => { sets.push(o); return store.set(k, v, o); }, putExport: (n, t) => store.putExport(n, t) };
  let orderCalls = 0;
  const client = { async query(_, path, params) {
    if (path === '/users/me') return { data: { id: 7 } };
    orderCalls++;
    return { data: { results: [order('A')], paging: { total: 1, offset: params.offset, limit: params.limit } } };
  } };
  const t = Date.parse('2026-11-06T15:00:00Z');
  const run = opts => new Analytics(client, { store: spy, now: () => t }).curvaAbc({ dias: 4, custos: false, exportar: false, ...opts });

  const first = await run();
  assert.equal(orderCalls, 4);
  assert.ok(sets.length === 3 && sets.every(o => o.ttlMs === CACHE_TTL_MS), 'cada dia fechado é gravado com validade de 25 h');
  assert.equal(first.frequenciaAtualizacao, '24 h');
  assert.equal(first.dadosAtualizadosEm, new Date(t).toISOString());

  orderCalls = 0; await run(); assert.equal(orderCalls, 1); // dentro de 24 h: só o dia de hoje

  const keys = ['2026-11-03', '2026-11-04', '2026-11-05'].map(d => 'orders2-7-' + d);
  for (const k of keys) await store.set(k, { ...(await store.get(k)), savedAt: t - CACHE_MAX_AGE_MS - 1000 }); // 24 h + 1 s
  orderCalls = 0; await run(); assert.equal(orderCalls, 4); // as 3 velhas foram relidas, mais o dia de hoje

  const semData = { ...(await store.get(keys[0])) }; delete semData.savedAt; await store.set(keys[0], semData);
  orderCalls = 0; await run(); assert.equal(orderCalls, 2); // cópia sem data de gravação é descartada

  orderCalls = 0; await run({ renovar: true }); assert.equal(orderCalls, 4); // a tarefa diária relê tudo
});
