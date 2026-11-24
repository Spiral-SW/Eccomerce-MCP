import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { TokenManager, saveToken, grantToken } from '../src/tokens.js';
import { authorizationRequest, callbackCode } from '../src/auth-cli.js';
import { publicError } from '../src/errors.js';

test('OAuth usa estado aleatório, PKCE no Meli e escopo somente leitura/offline', () => {
  const config = { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://local.example/callback' };
  const request = authorizationRequest('meli', config);
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('scope'), 'read offline_access');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.notEqual(request.state, authorizationRequest('meli', config).state);
  assert.equal(callbackCode(config.redirectUri + '?code=x&state=' + request.state, request.state, config.redirectUri), 'x');
  assert.throws(() => callbackCode(config.redirectUri + '?code=x&state=wrong', request.state, config.redirectUri), { code: 'state_mismatch' });
  assert.throws(() => callbackCode('https://evil.test/callback?code=x&state=' + request.state, request.state, config.redirectUri), { code: 'invalid_callback' });
  assert.throws(() => callbackCode(config.redirectUri + '?code=x&state=' + request.state + '&state=x', request.state, config.redirectUri), { code: 'invalid_callback' });
});
test('OAuth troca tokens somente no destino fixo e nunca ecoa o corpo de erro', async () => {
  let request;
  const config = { clientId: 'id', clientSecret: 'local-client-secret' };
  const token = await grantToken('bling', config, { grant_type: 'refresh_token', refresh_token: 'old-refresh-secret' }, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ access_token: 'new-access-secret', refresh_token: 'new-refresh-secret', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal(token.refresh_token, 'new-refresh-secret');
  assert.equal(request.url, 'https://api.bling.com.br/Api/v3/oauth/token');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.match(request.options.headers.Authorization, /^Basic /);
  assert.equal(request.options.body.has('client_secret'), false);
  await assert.rejects(grantToken('meli', config, {}, async () => new Response('local-client-secret', { status: 400 })), error => {
    assert.equal(JSON.stringify(publicError(error)).includes('local-client-secret'), false); return true;
  });
});
test('renovação concorrente rotaciona o arquivo uma vez e persiste o refresh novo', async () => {
  const temp = await mkdtemp(join(process.env.OLLYX_TEST_TEMP || tmpdir(), 'ollyx-mcp-test-'));
  try {
    const path = join(temp, 'meli.json');
    await saveToken(path, { access_token: 'old-access-secret', refresh_token: 'old-refresh-secret', expires_at: 1 });
    const config = loadConfig({ MELI_TOKEN_FILE: path, MELI_CLIENT_ID: 'id', MELI_CLIENT_SECRET: 'client-secret' }, false);
    let grants = 0;
    const manager = new TokenManager(config, { fetchImpl: async () => {
      grants++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ access_token: 'new-access-secret', refresh_token: 'new-refresh-secret', expires_in: 3600 }));
    } });
    const tokens = await Promise.all(Array.from({ length: 8 }, () => manager.get('meli')));
    assert.deepEqual(new Set(tokens), new Set(['new-access-secret']));
    assert.equal(grants, 1);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).refresh_token, 'new-refresh-secret');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('modo banco lê tokens a cada consulta e não renova OAuth compartilhado', async () => {
  const config = loadConfig({ MELI_USE_OLLYX_DATABASE: 'true', OLLYX_DATABASE_URL: 'postgresql://test.invalid/db' }, false);
  let reads = 0, oauthRequests = 0;
  const manager = new TokenManager(config, {
    databaseReader: async () => { reads++; return { access_token: 'shared-access-secret', expires_at: Date.now() + 3600000 }; },
    fetchImpl: async () => { oauthRequests++; throw new Error(); },
  });
  assert.equal(await manager.get('meli'), 'shared-access-secret');
  await manager.get('meli');
  await assert.rejects(manager.get('meli', 'shared-access-secret'), { code: 'reconnect_required' });
  assert.equal(reads, 3); assert.equal(oauthRequests, 0);
});
test('token de ambiente não é renovado e erros internos são sanitizados', async () => {
  const config = loadConfig({ BLING_ACCESS_TOKEN: 'environment-secret' }, false);
  const manager = new TokenManager(config);
  assert.equal(await manager.source('bling'), 'environment');
  assert.equal(await manager.get('bling'), 'environment-secret');
  await assert.rejects(manager.get('bling', 'environment-secret'), { code: 'reconnect_required' });
  assert.equal(JSON.stringify(publicError(new Error('postgresql://user:secret@localhost/db'))).includes('secret'), false);
});

test('conexão compartilhada relê o cache sem alterar ou renovar credenciais', async () => {
  const temp = await mkdtemp(join(process.env.OLLYX_TEST_TEMP || tmpdir(), 'ollyx-mcp-test-'));
  try {
    const env = join(temp, '.env'), cache = join(temp, 'cache.json');
    await writeFile(env, 'TOKEN_CACHE_FILE=cache.json\n');
    const first = JSON.stringify({ access_token: 'shared-first-secret', refresh_token: 'never-used-secret' });
    await writeFile(cache, first);
    let requests = 0;
    const manager = new TokenManager(loadConfig({ MELI_SHARED_ENV_FILE: env }, false), { fetchImpl: async () => { requests++; throw new Error(); } });
    assert.equal(await manager.source('meli'), 'shared_connection_read_only');
    assert.equal(await manager.get('meli'), 'shared-first-secret');
    assert.equal(await readFile(cache, 'utf8'), first);
    await assert.rejects(manager.get('meli', 'shared-first-secret'), { code: 'reconnect_required' });
    await writeFile(cache, JSON.stringify({ access_token: 'shared-second-secret', expires_at: new Date(Date.now() + 3600000).toISOString() }));
    assert.equal(await manager.get('meli', 'shared-first-secret'), 'shared-second-secret');
    assert.equal(requests, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
