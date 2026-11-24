import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { publicError } from '../src/errors.js';
const config = () => loadConfig({ OLLYX_MAX_RESPONSE_BYTES: '1024' }, false);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const client = (fetchImpl, options = {}) => new ApiClient(config(), { get: async () => 'test-access-secret' }, { fetchImpl, sleep: async () => {}, ...options });

test('consultas usam somente GET, host fixo, Bearer em header e redirects bloqueados', async () => {
  let request;
  const api = client(async (url, options) => { request = { url, options }; return json({ data: [] }); });
  await api.query('bling', '/produtos', { nome: 'x&method=POST' });
  assert.equal(new URL(request.url).origin, 'https://api.bling.com.br');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'manual');
  assert.equal(request.options.headers.Authorization, 'Bearer test-access-secret');
  assert.equal(new URL(request.url).searchParams.get('nome'), 'x&method=POST');
  assert.equal(request.options.body, undefined);
});
test('redige credenciais em respostas JSON e não ecoa corpo de erros', async () => {
  const api = client(async () => json({ access_token: 'oops', nested: { refresh_token: 'oops' }, text: 'test-access-secret' }));
  const r = await api.query('meli', '/users/me');
  assert.equal(JSON.stringify(r).includes('test-access-secret'), false);
  assert.equal(r.data.nested.refresh_token, '[REDACTED]');
  const denied = client(async () => json({ token: 'test-access-secret' }, 403));
  await assert.rejects(denied.query('meli', '/users/me'), error => {
    assert.equal(error.code, 'scope_denied');
    assert.equal(JSON.stringify(publicError(error)).includes('test-access-secret'), false);
    return true;
  });
});
test('não segue redirect nem aceita resposta acima do limite', async () => {
  await assert.rejects(client(async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } })).query('meli', '/users/me'), { code: 'redirect_blocked' });
  await assert.rejects(client(async () => json({ big: 'x'.repeat(2000) })).query('meli', '/users/me'), { code: 'response_too_large' });
  await assert.rejects(client(async () => new Response('{', { headers: { 'content-type': 'application/json' } })).query('meli', '/users/me'), { code: 'invalid_response' });
});
test('401 renova somente uma vez e 429 respeita Retry-After', async () => {
  let requests = 0, renewals = 0;
  const api = new ApiClient(config(), { get: async (_p, stale) => { if (stale) renewals++; return stale ? 'new-secret' : 'old-secret'; } },
    { sleep: async () => {}, fetchImpl: async () => { requests++; return requests === 1 ? json({}, 401) : json({ ok: true }); } });
  await api.query('meli', '/users/me');
  assert.equal(renewals, 1); assert.equal(requests, 2);
  await assert.rejects(client(async () => json({}, 429, { 'retry-after': '120' })).query('bling', '/produtos'), { code: 'rate_limited' });
});
test('limita retentativas e serializa espaçamento entre consultas', async () => {
  let calls = 0;
  await assert.rejects(client(async () => { calls++; return json({}, 503); }).query('meli', '/users/me'));
  assert.equal(calls, 3);
  let time = 0;
  const sent = [];
  const api = client(async () => { sent.push(time); return json({}); }, { now: () => time, sleep: async n => { time += n; } });
  await Promise.all(Array.from({ length: 5 }, () => api.query('bling', '/produtos')));
  assert.equal(sent.length, 5);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] >= 400);
});
test('paginação Bling sinaliza limite, continuação e fim da sequência', async () => {
  const api = client(async url => json({ data: Number(new URL(url).searchParams.get('pagina')) === 1 ? [1, 2] : [3] }));
  const partial = await api.pages('bling', '/produtos', { limite: 2 }, 1);
  assert.equal(partial.complete, false); assert.equal(partial.nextParams.pagina, 2);
  const full = await api.pages('bling', '/produtos', { limite: 2 }, 5);
  assert.equal(full.complete, true); assert.equal(full.pages.length, 2);
});
test('Meli avança pelo limite efetivo e não declara completude sem metadados', async () => {
  const offsets = [];
  const api = client(async url => {
    const offset = Number(new URL(url).searchParams.get('offset')); offsets.push(offset);
    return json({ results: offset === 0 ? [1, 2] : [3], paging: { offset, limit: 2, total: 3 } });
  });
  const full = await api.pages('meli', '/orders/search', { limit: 100 });
  assert.equal(full.complete, true); assert.deepEqual(offsets, [0, 2]);
  const unknown = await client(async () => json({ results: [1] })).pages('meli', '/orders/search');
  assert.equal(unknown.complete, false); assert.equal(unknown.reason, 'unknown_pagination');
  const inconsistent = await client(async () => json({ results: [1], paging: { offset: 0, limit: 50, total: 90 } })).pages('meli', '/orders/search');
  assert.equal(inconsistent.complete, false);
});
test('erro parcial e páginas repetidas preservam resultados e não declaram tudo consultado', async () => {
  let page = 0;
  const broken = client(async () => ++page === 1 ? json({ data: [1] }) : json({}, 403));
  const partial = await broken.pages('bling', '/produtos', { limite: 1 });
  assert.equal(partial.pages.length, 1); assert.equal(partial.complete, false); assert.equal(partial.nextParams.pagina, 2);
  const repeated = await client(async () => json({ data: [1] })).pages('bling', '/produtos', { limite: 1 });
  assert.equal(repeated.reason, 'repeated_page'); assert.equal(repeated.complete, false);
  await assert.rejects(client(async () => json({})).pages('meli', '/users/1/items/search', { search_type: 'scan' }), { code: 'cursor_pagination' });
});
test('texto e binário são retornados sem seguir links ou gravar arquivos', async () => {
  assert.equal((await client(async () => new Response('<xml/>', { headers: { 'content-type': 'application/xml' } })).query('bling', '/nfe/documento/123')).data, '<xml/>');
  assert.equal((await client(async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'application/pdf' } })).query('meli', '/shipment_labels')).data.encoding, 'base64');
});
