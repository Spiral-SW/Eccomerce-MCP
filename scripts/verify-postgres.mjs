import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
// Verificação de integração contra um Postgres real em memória (PGlite). Não faz parte do pacote nem do `npm test`.
// Uso: npm i --no-save @electric-sql/pglite && node scripts/verify-postgres.mjs
let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); }
catch { console.error('Instale primeiro: npm i --no-save @electric-sql/pglite'); process.exit(1); }

const R = new URL('../', import.meta.url).href;
const sqlFile = new URL('../sql/001_mcp_remote.sql', import.meta.url);
const { PgOAuthDb } = await import(R + 'src/remote/pg-db.js');
const { OAuthServer, sha } = await import(R + 'src/remote/oauth.js');
const { PgStore } = await import(R + 'src/store.js');
const { PgTokenManager, parseKey } = await import(R + 'src/remote/provider-tokens.js');
const { loadConfig } = await import(R + 'src/config.js');
const { run } = await import(R + 'scripts/remote-admin.js');

const db = new PGlite();
// Adaptador com a superfície de pg.Pool usada pelo código (query, connect/release).
// PGlite tem UMA conexão, e pg_advisory_xact_lock é reentrante na mesma sessão. Para emular sessões distintas
// (como num pg.Pool real), cada "conexão" adquire um mutex em JS ao pedir a trava e o solta no COMMIT/ROLLBACK.
const mutexes = new Map();
const pool = {
  query: (text, params) => db.query(text, params),
  connect: async () => {
    let held = null;
    const free = () => { if (held) { held(); held = null; } };
    return {
      async query(t, p) {
        if (/pg_advisory_xact_lock/.test(t)) {
          const key = p[0], prev = mutexes.get(key) || Promise.resolve();
          let release; const mine = new Promise(r => { release = r; });
          mutexes.set(key, prev.then(() => mine));
          await prev; held = release;
          return { rows: [] }; // o lock real é o mutex; não repassa ao banco de conexão única
        }
        try { return await db.query(t, p); } finally { if (/^(COMMIT|ROLLBACK)/.test(t)) free(); }
      },
      release() { free(); },
    };
  },
};
let n = 0; const ok = name => console.log(`ok ${++n} - ${name}`);

// 1. migração idempotente
const sql = readFileSync(sqlFile, 'utf8');
await db.exec(sql); await db.exec(sql); ok('migração aplica duas vezes sem erro');

// 2. CLI admin contra o banco real
const out = [];
await run(['user:create', 'Ana'], pool, l => out.push(l));
await run(['user:create', 'Chefe', '--admin'], pool, l => out.push(l));
const code = /(oxu_[\w-]+)/.exec(out[0])[1], adminCode = /(oxu_[\w-]+)/.exec(out[1])[1];
const list = []; await run(['user:list'], pool, l => list.push(l));
assert.equal(list.length, 2); ok('user:create e user:list');

// 3. fluxo OAuth completo com PgOAuthDb
const oauth = new OAuthServer({ db: new PgOAuthDb(pool), issuer: 'https://mcp.test' });
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const reg = JSON.parse((await oauth.register({ client_name: 'Claude', redirect_uris: [REDIRECT] }, '1.1.1.1')).body);
const verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
const params = { client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st' };
assert.equal((await oauth.authorizeGet(params)).status, 200);
assert.equal((await oauth.authorizePost({ ...params, codigo: 'errado' }, '2.2.2.2')).status, 401);
const redirect = await oauth.authorizePost({ ...params, codigo: code }, '2.2.2.2');
assert.equal(redirect.status, 302);
const authCode = new URL(redirect.headers.Location).searchParams.get('code');
const tok = JSON.parse((await oauth.token({ grant_type: 'authorization_code', client_id: reg.client_id, code: authCode, redirect_uri: REDIRECT, code_verifier: verifier }, '3.3.3.3')).body);
assert.ok(tok.access_token); ok('registro, autorização e troca de código por tokens (SQL real)');
const reuse = await oauth.token({ grant_type: 'authorization_code', client_id: reg.client_id, code: authCode, redirect_uri: REDIRECT, code_verifier: verifier }, '3.3.3.3');
assert.equal(reuse.status, 400); ok('código de autorização é de uso único');
const user = await oauth.authenticate('Bearer ' + tok.access_token);
assert.deepEqual([user.nome, user.papel], ['Ana', 'user']); ok('authenticate lê token e usuário por JOIN');

// concorrência: dois pedidos simultâneos com o mesmo código
const reg2 = JSON.parse((await oauth.register({ redirect_uris: [REDIRECT] }, '1.1.1.1')).body);
const v2 = randomBytes(48).toString('base64url'), c2 = createHash('sha256').update(v2).digest('base64url');
const p2 = { ...params, client_id: reg2.client_id, code_challenge: c2 };
const code2 = new URL((await oauth.authorizePost({ ...p2, codigo: code }, '2.2.2.2')).headers.Location).searchParams.get('code');
const body2 = { grant_type: 'authorization_code', client_id: reg2.client_id, code: code2, redirect_uri: REDIRECT, code_verifier: v2 };
const both = await Promise.all([oauth.token(body2, '4.4.4.4'), oauth.token(body2, '4.4.4.4')]);
assert.deepEqual(both.map(r => r.status).sort(), [200, 400]); ok('troca simultânea do mesmo código: só uma vence');

// refresh: rotação + reuso revoga a família
const rt = await oauth.token({ grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: tok.refresh_token }, '5.5.5.5');
assert.equal(rt.status, 200); const t2 = JSON.parse(rt.body);
assert.equal((await oauth.token({ grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: tok.refresh_token }, '5.5.5.5')).status, 400);
assert.equal(await oauth.authenticate('Bearer ' + t2.access_token), null); ok('refresh rotaciona; reuso derruba a família (access incluído)');

// desativar usuário revoga
const ana = (await pool.query("SELECT id FROM mcp.users WHERE nome='Ana'")).rows[0].id;
const t3 = await (async () => { const v = randomBytes(48).toString('base64url'); const ch = createHash('sha256').update(v).digest('base64url'); const pp = { ...params, code_challenge: ch };
  const c = new URL((await oauth.authorizePost({ ...pp, codigo: code }, '6.6.6.6')).headers.Location).searchParams.get('code');
  return JSON.parse((await oauth.token({ grant_type: 'authorization_code', client_id: reg.client_id, code: c, redirect_uri: REDIRECT, code_verifier: v }, '6.6.6.6')).body); })();
assert.ok(await oauth.authenticate('Bearer ' + t3.access_token));
await run(['user:disable', ana], pool, () => {});
assert.equal(await oauth.authenticate('Bearer ' + t3.access_token), null); ok('user:disable revoga sessões imediatamente');
await run(['user:enable', ana], pool, () => {});
await run(['user:rotate', ana], pool, l => out.push(l));
assert.equal((await oauth.authorizePost({ ...params, codigo: code }, '7.7.7.7')).status, 401); ok('user:rotate invalida o código antigo');

// limitador por IP
let last; for (let i = 0; i < 12; i++) last = await oauth.authorizePost({ ...params, codigo: 'x' + i }, '9.9.9.9');
assert.equal(last.status, 429); ok('limitador de tentativas (mcp.hits)');

// 4. PgStore
const store = new PgStore(pool, { signer: name => 'https://mcp.test/dl/' + name });
assert.equal(await store.get('chave'), null);
await store.set('chave', { a: [1, 2] }); assert.deepEqual(await store.get('chave'), { a: [1, 2] });
await store.set('chave', { a: 3 }); assert.deepEqual(await store.get('chave'), { a: 3 });
await store.set('efemera', { x: 1 }, { ttlMs: 1 }); await new Promise(r => setTimeout(r, 30)); assert.equal(await store.get('efemera'), null);
const exp = await store.putExport('curva.csv', 'a;b'); assert.equal(exp.download, 'https://mcp.test/dl/curva.csv'); assert.equal(await store.getExport('curva.csv'), 'a;b');
await store.del('chave'); assert.equal(await store.get('chave'), null);
await store.set('k1', { n: 1 }); await store.set('k2', { n: 2 }); await store.set('k3', { n: 3 }, { ttlMs: 1 }); await new Promise(r => setTimeout(r, 30));
// retenção: cópia de pedidos antiga e SEM validade é apagada pela limpeza; cópia recente e outras chaves ficam
await pool.query("INSERT INTO mcp.kv (key, value, expires_at, updated_at) VALUES ('orders2-9-antigo', '{}', NULL, now() - interval '26 hours'), ('orders2-9-recente', '{}', NULL, now() - interval '2 hours'), ('bling-catalogo-x', '{}', NULL, now() - interval '30 hours')");
const purged = await new PgOAuthDb(pool).purgeStale();
assert.equal(purged.apagadas >= 1, true);
const restam = (await pool.query("SELECT key FROM mcp.kv WHERE key IN ('orders2-9-antigo','orders2-9-recente','bling-catalogo-x') ORDER BY key")).rows.map(r => r.key);
assert.deepEqual(restam, ['bling-catalogo-x', 'orders2-9-recente']);
const many = await store.getMany(['k1', 'k2', 'k3', 'inexistente']);
assert.deepEqual([...many.keys()].sort(), ['k1', 'k2']); assert.deepEqual(many.get('k2'), { n: 2 }); assert.equal((await store.getMany([])).size, 0);
assert.equal(await store.withLock('x', async () => 42), 42); ok('PgStore: get/set/upsert/ttl/export/del/lock');

// 5. PgTokenManager: cifra em repouso, renova sob trava
const key = parseKey(randomBytes(32).toString('base64'));
const config = loadConfig({ BLING_CLIENT_ID: 'i', BLING_CLIENT_SECRET: 's' }, false);
let now = Date.now(), refreshes = 0;
const fetchImpl = async () => { refreshes++; const buf = Buffer.from(JSON.stringify({ access_token: 'NOVO' + refreshes, refresh_token: 'RNOVO' + refreshes, expires_in: 7200 })); return { ok: true, status: 200, headers: new Headers({ 'content-length': String(buf.length) }), body: new Response(buf).body }; };
const tm = new PgTokenManager(config, { pool, store, key, fetchImpl, now: () => now });
await assert.rejects(tm.get('bling'), e => e.code === 'not_configured');
assert.equal(await tm.source('bling'), 'not_configured');
await tm.save('bling', { access_token: 'ACESSO-SECRETO', refresh_token: 'REFRESH-SECRETO', expires_at: now + 3600e3 });
const raw = (await pool.query("SELECT access_token_enc, refresh_token_enc FROM mcp.provider_tokens WHERE provider='bling'")).rows[0];
assert.equal(JSON.stringify(raw).includes('SECRETO'), false); ok('tokens dos provedores ficam cifrados no banco');
assert.equal(await tm.get('bling'), 'ACESSO-SECRETO'); assert.equal(refreshes, 0);
assert.equal(await tm.source('bling'), 'oauth_database'); ok('leitura de token válido sem renovar');
now += 3590e3; // perto de expirar
const results = await Promise.all([tm.get('bling'), tm.get('bling'), tm.get('bling')]);
assert.equal(refreshes, 1); assert.deepEqual(new Set(results), new Set(['NOVO1'])); ok('3 leituras simultâneas com token vencendo: 1 só renovação');
assert.equal(await tm.get('bling', 'NOVO1') !== 'NOVO1', true); ok('token recusado (stale) força nova renovação');
const wrong = new PgTokenManager(config, { pool, store, key: parseKey(randomBytes(32).toString('base64')), fetchImpl, now: () => now });
await assert.rejects(wrong.get('bling'), e => e.code === 'decrypt_failed'); ok('chave errada não decifra');

console.log(`\nTODOS OS ${n} GRUPOS PASSARAM NO POSTGRES REAL (PGlite)`);
await db.close();
