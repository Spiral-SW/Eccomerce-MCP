import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { OAuthServer, sha } from '../src/remote/oauth.js';
import { FakeOAuthDb } from './helpers/fake-oauth-db.js';

const ISSUER = 'https://mcp.example.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const pkce = () => { const verifier = randomBytes(48).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };

function setup(over = {}) {
  const db = new FakeOAuthDb();
  const clock = { t: 1_700_000_000_000 };
  db.addUser({ id: 'u1', nome: 'Ana', papel: 'user', ativo: true, codeHash: sha('oxu_segredo-da-ana') });
  db.addUser({ id: 'u2', nome: 'Inativo', papel: 'user', ativo: false, codeHash: sha('oxu_inativo') });
  const server = new OAuthServer({ db, issuer: ISSUER, now: () => clock.t, ...over });
  return { db, clock, server };
}
async function registrar(server, uris = [REDIRECT]) {
  const res = await server.register({ client_name: 'Claude', redirect_uris: uris }, '1.1.1.1');
  return { res, body: JSON.parse(res.body) };
}
const authParams = (clientId, challenge, extra = {}) => ({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra });
async function login(server, clientId, challenge, codigo = 'oxu_segredo-da-ana') {
  const res = await server.authorizePost({ ...authParams(clientId, challenge), codigo }, '2.2.2.2');
  return res;
}

test('metadados anunciam PKCE S256, DCR e cliente público', () => {
  const { server } = setup();
  const meta = JSON.parse(server.metadata().body);
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.equal(meta.registration_endpoint, ISSUER + '/register');
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(JSON.parse(server.protectedResource().body).resource, ISSUER + '/mcp');
});

test('registro valida redirect_uri: https ok, http só em loopback, resto recusado', async () => {
  const { server } = setup();
  assert.equal((await registrar(server)).res.status, 201);
  assert.equal((await registrar(server, ['http://localhost:3000/cb'])).res.status, 201);
  for (const bad of ['http://evil.test/cb', 'javascript:alert(1)', 'https://a.test/cb#frag', 'https://u:p@a.test/cb', 'nao-url']) {
    await assert.rejects(registrar(server, [bad]), e => e.code === 'invalid_redirect_uri', bad);
  }
  await assert.rejects(server.register({ redirect_uris: [] }, '1.1.1.1'), e => e.code === 'invalid_redirect_uri');
});

test('fluxo completo: registrar, autorizar com código, trocar por tokens com PKCE e autenticar', async () => {
  const { server } = setup();
  const { body: client } = await registrar(server);
  const { verifier, challenge } = pkce();
  const page = await server.authorizeGet(authParams(client.client_id, challenge));
  assert.equal(page.status, 200);
  assert.match(page.body, /Código de acesso/);
  assert.equal(page.headers['X-Frame-Options'], 'DENY');
  const redirect = await login(server, client.client_id, challenge);
  assert.equal(redirect.status, 302);
  const loc = new URL(redirect.headers.Location);
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'xyz');
  assert.equal(loc.searchParams.get('iss'), ISSUER);
  const tok = await server.token({ grant_type: 'authorization_code', client_id: client.client_id, code: loc.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: verifier }, '3.3.3.3');
  assert.equal(tok.status, 200);
  const t = JSON.parse(tok.body);
  assert.equal(t.token_type, 'Bearer');
  assert.deepEqual(await server.authenticate('Bearer ' + t.access_token), { userId: 'u1', nome: 'Ana', papel: 'user', clientId: client.client_id });
  assert.equal(await server.authenticate('Bearer oxa_naoexiste_naoexiste_naoexiste'), null);
  assert.equal(await server.authenticate(undefined), null);
});

test('código errado, usuário inativo e redirect_uri fora do registro são recusados', async () => {
  const { server } = setup();
  const { body: client } = await registrar(server);
  const { challenge } = pkce();
  assert.equal((await login(server, client.client_id, challenge, 'errado')).status, 401);
  assert.equal((await login(server, client.client_id, challenge, 'oxu_inativo')).status, 401);
  const evil = await server.authorizeGet(authParams(client.client_id, challenge, { redirect_uri: 'https://evil.test/cb' }));
  assert.equal(evil.status, 400); // página de erro, nunca redireciona para o endereço não registrado
  assert.equal(evil.headers.Location, undefined);
  const noPkce = await server.authorizeGet(authParams(client.client_id, challenge, { code_challenge_method: 'plain' }));
  assert.equal(noPkce.status, 302);
  assert.equal(new URL(noPkce.headers.Location).searchParams.get('error'), 'invalid_request');
});

test('PKCE: verifier errado e código reutilizado falham; código expira', async () => {
  const { server, clock } = setup();
  const { body: client } = await registrar(server);
  const mk = async () => { const p = pkce(); const r = await login(server, client.client_id, p.challenge); return { ...p, code: new URL(r.headers.Location).searchParams.get('code') }; };
  const ex = (code, verifier) => server.token({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier }, '4.4.4.4');
  const a = await mk();
  assert.equal((await ex(a.code, pkce().verifier)).status, 400); // verifier de outra sessão
  assert.equal((await ex(a.code, a.verifier)).status, 400); // o código já foi consumido na tentativa anterior
  const b = await mk();
  assert.equal((await ex(b.code, b.verifier)).status, 200);
  assert.equal((await ex(b.code, b.verifier)).status, 400); // reuso
  const c = await mk(); clock.t += 11 * 60e3;
  assert.equal((await ex(c.code, c.verifier)).status, 400); // expirou
});

test('refresh rotaciona; reuso do refresh antigo revoga a família inteira', async () => {
  const { server } = setup();
  const { body: client } = await registrar(server);
  const { verifier, challenge } = pkce();
  const r = await login(server, client.client_id, challenge);
  const code = new URL(r.headers.Location).searchParams.get('code');
  const first = JSON.parse((await server.token({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier }, '5.5.5.5')).body);
  const second = JSON.parse((await server.token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: first.refresh_token }, '5.5.5.5')).body);
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.ok(await server.authenticate('Bearer ' + second.access_token));
  const replay = await server.token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: first.refresh_token }, '5.5.5.5');
  assert.equal(replay.status, 400);
  assert.equal(await server.authenticate('Bearer ' + second.access_token), null); // revogar a família derruba também os access tokens
  const afterRevoke = await server.token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: second.refresh_token }, '5.5.5.5');
  assert.equal(afterRevoke.status, 400); // família revogada: o refresh novo também morreu
});

test('access token expira e usuário desativado perde o acesso na hora', async () => {
  const { server, clock, db } = setup();
  const { body: client } = await registrar(server);
  const { verifier, challenge } = pkce();
  const code = new URL((await login(server, client.client_id, challenge)).headers.Location).searchParams.get('code');
  const t = JSON.parse((await server.token({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier }, '6.6.6.6')).body);
  db.users.get(sha('oxu_segredo-da-ana')).ativo = false;
  assert.equal(await server.authenticate('Bearer ' + t.access_token), null);
  db.users.get(sha('oxu_segredo-da-ana')).ativo = true;
  assert.ok(await server.authenticate('Bearer ' + t.access_token));
  clock.t += 61 * 60e3;
  assert.equal(await server.authenticate('Bearer ' + t.access_token), null);
});

test('força bruta no código de acesso é limitada por IP', async () => {
  const { server } = setup();
  const { body: client } = await registrar(server);
  const { challenge } = pkce();
  let last;
  for (let i = 0; i < 12; i++) last = await server.authorizePost({ ...authParams(client.client_id, challenge), codigo: 'tentativa' + i }, '9.9.9.9');
  assert.equal(last.status, 429);
  const other = await server.authorizePost({ ...authParams(client.client_id, challenge), codigo: 'oxu_segredo-da-ana' }, '8.8.8.8');
  assert.equal(other.status, 302); // outro IP não é afetado
});

test('401 aponta para os metadados do recurso protegido', () => {
  const { server } = setup();
  const res = server.unauthorized();
  assert.equal(res.status, 401);
  assert.match(res.headers['WWW-Authenticate'], /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/);
});

test('página escapa HTML do nome do cliente (sem XSS)', async () => {
  const { server } = setup();
  const res = await server.register({ client_name: '<script>alert(1)</script>', redirect_uris: [REDIRECT] }, '1.1.1.1');
  const client = JSON.parse(res.body);
  const page = await server.authorizeGet(authParams(client.client_id, pkce().challenge));
  assert.equal(page.body.includes('<script>alert(1)</script>'), false);
  assert.match(page.body, /&lt;script&gt;/);
});

test('registro só aceita destinos https autorizados (padrão: Claude); curinga libera; loopback sempre vale', async () => {
  const { server } = setup();
  for (const bad of ['https://atacante.example/cb', 'https://claude.ai.atacante.example/cb', 'https://notclaude.ai/cb']) {
    await assert.rejects(registrar(server, [bad]), e => e.code === 'invalid_redirect_uri', bad);
  }
  assert.equal((await registrar(server, ['https://claude.ai/api/mcp/auth_callback'])).res.status, 201);
  assert.equal((await registrar(server, ['https://app.claude.com/cb'])).res.status, 201); // subdomínio
  assert.equal((await registrar(server, ['http://127.0.0.1:8080/cb'])).res.status, 201);
  const open = setup({ allowedHosts: ['*'] }).server;
  assert.equal((await registrar(open, ['https://qualquer.example/cb'])).res.status, 201);
  const custom = setup({ allowedHosts: ['ollyx.example'] }).server;
  assert.equal((await registrar(custom, ['https://x.ollyx.example/cb'])).res.status, 201);
  await assert.rejects(registrar(custom, ['https://claude.ai/cb']), e => e.code === 'invalid_redirect_uri');
});

test('tela de login mostra o destino do redirecionamento', async () => {
  const { server } = setup();
  const { body: client } = await registrar(server);
  const page = await server.authorizeGet(authParams(client.client_id, pkce().challenge));
  assert.match(page.body, /<b>claude\.ai<\/b>/);
});

test('o formulário REAL da tela reenvia todos os campos do pedido: login pelo navegador funciona de ponta a ponta', async () => {
  const { server } = setup();
  const { body: client } = await registrar(server);
  const { verifier, challenge } = pkce();
  const query = { ...authParams(client.client_id, challenge, { scope: 'mcp', resource: ISSUER + '/mcp' }) };
  const page = await server.authorizeGet(query);
  // monta o POST só com o que o navegador enviaria: os <input type="hidden"> da página + o código digitado
  const posted = {};
  for (const m of page.body.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) posted[m[1]] = m[2].replace(/&amp;/g, '&');
  posted.codigo = 'oxu_segredo-da-ana';
  const res = await server.authorizePost(posted, '2.2.2.2');
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.Location);
  assert.equal(loc.searchParams.get('error'), null, 'não pode voltar com erro: ' + loc.search);
  assert.ok(loc.searchParams.get('code'));
  const tok = await server.token({ grant_type: 'authorization_code', client_id: client.client_id, code: loc.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: verifier }, '3.3.3.3');
  assert.equal(tok.status, 200);
});

test('logins que dão certo não consomem o limite; só as falhas contam, e o bloqueio vale para o IP', async () => {
  const { server } = setup();
  const { body: client } = await registrar(server);
  const { challenge } = pkce();
  for (let i = 0; i < 25; i++) {
    const ok = await server.authorizePost({ ...authParams(client.client_id, challenge), codigo: 'oxu_segredo-da-ana' }, '5.5.5.5');
    assert.equal(ok.status, 302, 'sucesso ' + i);
  }
  let last;
  for (let i = 0; i < 11; i++) last = await server.authorizePost({ ...authParams(client.client_id, challenge), codigo: 'errado' + i }, '5.5.5.5');
  assert.equal(last.status, 429);
  const blocked = await server.authorizePost({ ...authParams(client.client_id, challenge), codigo: 'oxu_segredo-da-ana' }, '5.5.5.5');
  assert.equal(blocked.status, 429); // IP bloqueado por força bruta, mesmo com o código certo
  const other = await server.authorizePost({ ...authParams(client.client_id, challenge), codigo: 'oxu_segredo-da-ana' }, '6.6.6.6');
  assert.equal(other.status, 302);
});

test('ChatGPT pode registrar seus endereços de retorno; domínios parecidos continuam recusados', async () => {
  const { server } = setup();
  for (const ok of ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/abc123', 'https://platform.openai.com/apps-manage/oauth']) {
    assert.equal((await registrar(server, [ok])).res.status, 201, ok);
  }
  for (const bad of ['https://chatgpt.com.atacante.example/cb', 'https://notchatgpt.com/cb', 'https://openai.com.evil.test/cb', 'https://evil-openai.com/cb']) {
    await assert.rejects(registrar(server, [bad]), e => e.code === 'invalid_redirect_uri', bad);
  }
});
