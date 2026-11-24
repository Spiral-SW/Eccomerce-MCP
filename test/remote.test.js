import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, exportSigner } from '../src/remote/app.js';
import { OAuthServer, sha } from '../src/remote/oauth.js';
import { loadConfig } from '../src/config.js';
import { FakeOAuthDb } from './helpers/fake-oauth-db.js';
import { MemStore } from './helpers/mem-store.js';

const REDIRECT = 'http://127.0.0.1:9999/callback';

function tokenResponse() {
  const buf = Buffer.from(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }));
  return { ok: true, status: 200, headers: new Headers({ 'content-length': String(buf.length) }), body: new Response(buf).body };
}
async function boot(fetchImpl = async () => tokenResponse(), extra = {}) {
  const db = new FakeOAuthDb();
  db.addUser({ id: 'u1', nome: 'Ana', papel: 'user', ativo: true, codeHash: sha('oxu_ana') });
  db.addUser({ id: 'a1', nome: 'Admin', papel: 'admin', ativo: true, codeHash: sha('oxu_admin') });
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const signer = exportSigner({ key: randomBytes(32), issuer: base });
  const store = new MemStore({ signer: signer.sign });
  const saved = [];
  const refreshed = [];
  const tokens = { source: async () => 'oauth_database', get: async () => 'tok', save: async (p, t) => saved.push([p, t]), refreshNow: async p => { refreshed.push(p); return 'renovado'; } };
  const config = loadConfig({ BLING_CLIENT_ID: 'bid', BLING_CLIENT_SECRET: 'bsecret', MELI_CLIENT_ID: 'mid', MELI_CLIENT_SECRET: 'msecret' }, false);
  const oauth = new OAuthServer({ db, issuer: base });
  server.on('request', createApp({ config, oauth, tokens, store, signer, fetchImpl, ...extra }));
  return { base, server, store, saved, refreshed, close: () => new Promise(r => server.close(r)) };
}
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o), redirect: 'manual' });

async function oauthLogin(base, codigo = 'oxu_ana') {
  const reg = await (await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Teste', redirect_uris: [REDIRECT] }) })).json();
  const verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = await fetch(base + '/authorize', form({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's1', codigo }));
  const code = new URL(auth.headers.get('location')).searchParams.get('code');
  const tok = await (await fetch(base + '/token', form({ grant_type: 'authorization_code', client_id: reg.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier }))).json();
  return { reg, tok };
}

test('/mcp sem bearer devolve 401 com metadados; metadados públicos respondem', async () => {
  const s = await boot();
  try {
    const r = await fetch(s.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata=/);
    const meta = await (await fetch(s.base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(meta.token_endpoint, s.base + '/token');
    const prm = await (await fetch(s.base + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(prm.resource, s.base + '/mcp');
    assert.equal((await fetch(s.base + '/health')).status, 200);
    assert.equal((await fetch(s.base + '/nada')).status, 404);
  } finally { await s.close(); }
});

test('cliente MCP real: OAuth completo, depois lista ferramentas e chama ollyx_status pela rede', async () => {
  const s = await boot();
  try {
    const { tok } = await oauthLogin(s.base);
    const transport = new StreamableHTTPClientTransport(new URL(s.base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + tok.access_token } } });
    const client = new Client({ name: 'teste-rede', version: '1' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(tools, ['ollyx_consultar', 'ollyx_consultar_paginas', 'ollyx_curva_abc', 'ollyx_depara_sku', 'ollyx_recursos', 'ollyx_status']);
    const status = (await client.callTool({ name: 'ollyx_status', arguments: {} })).structuredContent;
    assert.equal(status.transport, 'http');
    assert.equal(status.armazenamento, 'postgres');
    assert.equal(status.dataDir, undefined);
    assert.equal(status.integrations[0].credentialSource, 'oauth_database');
    await client.close();
    const bad = await fetch(s.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer oxa_invalido_invalido_invalido', accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(bad.status, 401);
  } finally { await s.close(); }
});

test('download de exportação exige assinatura válida e não expirada', async () => {
  const s = await boot();
  try {
    const { download } = await s.store.putExport('curva.csv', 'a;b\r\n1;2\r\n');
    const ok = await fetch(download);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/csv/);
    assert.equal(await ok.text(), 'a;b\r\n1;2\r\n');
    assert.equal((await fetch(download.replace(/sig=.{4}/, 'sig=xxxx'))).status, 403);
    assert.equal((await fetch(s.base + '/api/exports/curva.csv')).status, 403);
    const old = exportSigner({ key: randomBytes(32), issuer: s.base, ttlMs: -1000 }).sign('curva.csv');
    assert.equal((await fetch(old)).status, 403);
  } finally { await s.close(); }
});

test('conexão de provedor: só admin inicia; callback troca o código, guarda o token e o state vale uma vez', async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(s.base + '/admin/connect/bling', form({ codigo: 'oxu_ana' }))).status, 403);
    assert.equal((await fetch(s.base + '/admin/connect/bling', form({ codigo: 'errado' }))).status, 403);
    const start = await fetch(s.base + '/admin/connect/bling', form({ codigo: 'oxu_admin' }));
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://www.bling.com.br/Api/v3/oauth/authorize');
    assert.equal(loc.searchParams.get('redirect_uri'), s.base + '/admin/callback/bling');
    const state = loc.searchParams.get('state');
    const cb = await fetch(`${s.base}/admin/callback/bling?code=abc&state=${state}`);
    assert.equal(cb.status, 200);
    assert.equal(s.saved.length, 1);
    assert.equal(s.saved[0][0], 'bling');
    assert.equal(s.saved[0][1].access_token, 'A');
    assert.equal((await fetch(`${s.base}/admin/callback/bling?code=abc&state=${state}`)).status, 400);
    assert.equal((await fetch(`${s.base}/admin/callback/bling?code=abc&state=forjado`)).status, 400);
    assert.equal((await fetch(`${s.base}/admin/callback/meli?code=abc&state=${state}`)).status, 400);
  } finally { await s.close(); }
});

test('falhas na conexão do provedor mostram o motivo, sem vazar segredos', async () => {
  const s = await boot(async () => ({ ok: false, status: 400, headers: new Headers(), body: null }));
  try {
    const start = await fetch(s.base + '/admin/connect/bling', form({ codigo: 'oxu_admin' }));
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const denied = await fetch(`${s.base}/admin/callback/bling?error=access_denied&state=${state}`);
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /access_denied/);
    const start2 = await fetch(s.base + '/admin/connect/bling', form({ codigo: 'oxu_admin' }));
    const state2 = new URL(start2.headers.get('location')).searchParams.get('state');
    const failed = await fetch(`${s.base}/admin/callback/bling?code=SEGREDO-DO-CODIGO&state=${state2}`);
    assert.equal(failed.status, 502);
    const html = await failed.text();
    assert.match(html, /oauth_failed/);
    assert.match(html, /HTTP 400/);
    assert.equal(html.includes('SEGREDO-DO-CODIGO'), false);
    assert.equal(s.saved.length, 0);
    const stale = await fetch(`${s.base}/admin/callback/bling?code=x&state=${state2}`);
    assert.equal(stale.status, 400);
    assert.match(await stale.text(), /inválida ou expirada/);
  } finally { await s.close(); }
});

test('CORS: preflight nos endpoints do protocolo, WWW-Authenticate exposto e páginas de login sem CORS', async () => {
  const s = await boot();
  try {
    for (const path of ['/register', '/token', '/mcp', '/.well-known/oauth-authorization-server']) {
      const pre = await fetch(s.base + path, { method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' } });
      assert.equal(pre.status, 204, path);
      assert.equal(pre.headers.get('access-control-allow-origin'), '*');
      assert.match(pre.headers.get('access-control-allow-headers'), /authorization/i);
    }
    const unauth = await fetch(s.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://claude.ai' }, body: '{}' });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('access-control-expose-headers'), /WWW-Authenticate/);
    const login = await fetch(s.base + '/authorize?client_id=x', { headers: { origin: 'https://claude.ai' } });
    assert.equal(login.headers.get('access-control-allow-origin'), null);
    const admin = await fetch(s.base + '/admin/connect/bling', { headers: { origin: 'https://claude.ai' } });
    assert.equal(admin.headers.get('access-control-allow-origin'), null);
  } finally { await s.close(); }
});

const fakeClient = (over = {}) => ({ stats: { calls: 0, ms: 0 }, async query(_, path, params) {
  if (over[path]) return over[path](params);
  if (path === '/users/me') return { data: { id: 7 } };
  if (path === '/orders/search') return { data: { results: [], paging: { total: 0, offset: params.offset, limit: params.limit } } };
  if (path === '/produtos') return { data: { data: [] } };
  throw new Error('inesperado ' + path);
} });

test('tarefa diária: sem segredo a rota não existe; com segredo errado 401; certo executa as etapas', async () => {
  const off = await boot(undefined, { client: fakeClient() });
  try { assert.equal((await fetch(off.base + '/api/cron/daily')).status, 404); } finally { await off.close(); }
  const s = await boot(undefined, { cronSecret: 'segredo-do-cron', client: fakeClient() });
  try {
    assert.equal((await fetch(s.base + '/api/cron/daily')).status, 401);
    assert.equal((await fetch(s.base + '/api/cron/daily', { headers: { authorization: 'Bearer errado' } })).status, 401);
    const ok = await fetch(s.base + '/api/cron/daily', { headers: { authorization: 'Bearer segredo-do-cron' } });
    assert.equal(ok.status, 200);
    const r = await ok.json();
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.etapas), ['banco', 'token-bling', 'token-meli', 'catalogo', 'pedidos', 'limpeza']);
    assert.deepEqual(s.refreshed, ['bling', 'meli']);
    assert.equal(r.etapas.pedidos.dias, 35);
    assert.equal(r.etapas.catalogo.produtos, 0);
  } finally { await s.close(); }
});

test('tarefa diária: uma etapa que falha é relatada (207) e não impede as demais', async () => {
  const client = fakeClient({ '/produtos': () => { const e = new Error('x'); e.code = 'reconnect_required'; throw Object.assign(e, { name: 'OllyxError' }); } });
  const s = await boot(undefined, { cronSecret: 'c', client });
  try {
    const res = await fetch(s.base + '/api/cron/daily', { headers: { authorization: 'Bearer c' } });
    assert.equal(res.status, 207);
    const r = await res.json();
    assert.equal(r.ok, false);
    assert.equal(r.etapas.catalogo.ok, false);
    assert.equal(r.etapas.pedidos.ok, true);
    assert.equal(r.etapas.banco.ok, true);
  } finally { await s.close(); }
});
