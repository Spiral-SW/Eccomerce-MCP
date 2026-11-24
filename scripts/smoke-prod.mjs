// Teste de fumaça do MCP em produção: login real, ferramentas pela rede, conexões Bling/ML, de-para, curva ABC e download.
// Uso (na pasta do projeto):  node scripts/smoke-prod.mjs
// Lê o código de administrador de OLLYX_ADMIN_CODE ou de %USERPROFILE%\.ollyx\remote-secrets.txt (nunca o imprime).
// Cada execução registra um cliente OAuth chamado "smoke" no banco (inofensivo). Sai com código 1 se algo falhar.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.env.OLLYX_URL || 'https://ollyx-mcp.vercel.app').replace(/\/$/, '');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const failures = [];
const check = (ok, label, detail = '') => { console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failures.push(label); };
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o), redirect: 'manual' });

function adminCode() {
  if (process.env.OLLYX_ADMIN_CODE) return process.env.OLLYX_ADMIN_CODE.trim();
  const text = readFileSync(homedir() + '/.ollyx/remote-secrets.txt', 'utf8');
  const m = /^OLLYX_ADMIN_CODE=(.+)$/m.exec(text);
  if (!m) throw new Error('OLLYX_ADMIN_CODE não encontrado.');
  return m[1].trim();
}

async function main() {
  check((await fetch(BASE + '/health')).status === 200, 'servidor responde (/health)');
  const meta = await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json();
  check(meta.issuer === BASE, 'metadados OAuth com o endereço certo', meta.issuer);

  const reg = await (await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'smoke', redirect_uris: [REDIRECT] }) })).json();
  const verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = { client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'smoke' };
  const wrong = await fetch(BASE + '/authorize', form({ ...params, codigo: 'oxu_codigo-errado' }));
  check(wrong.status === 401, 'código de acesso errado é recusado', 'HTTP ' + wrong.status);
  const auth = await fetch(BASE + '/authorize', form({ ...params, codigo: adminCode() }));
  const code = new URL(auth.headers.get('location') || 'http://x').searchParams.get('code');
  check(auth.status === 302 && !!code, 'login com o código de administrador', 'HTTP ' + auth.status);
  if (!code) return;
  const tok = await (await fetch(BASE + '/token', form({ grant_type: 'authorization_code', client_id: reg.client_id, code, redirect_uri: REDIRECT, code_verifier: verifier }))).json();
  check(!!tok.access_token, 'tokens emitidos (PKCE)');
  const noAuth = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  check(noAuth.status === 401, '/mcp sem token é recusado', 'HTTP ' + noAuth.status);
  if (!tok.access_token) return;

  const client = new Client({ name: 'smoke-prod', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + tok.access_token } } }));
  try {
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    check(tools.length === 6, 'seis ferramentas pela rede', tools.join(', '));

    const st = (await client.callTool({ name: 'ollyx_status', arguments: { verificar: true } })).structuredContent;
    for (const t of st.testes || []) check(t.ok, 'conexão ' + t.teste, t.ok ? t.ms + ' ms' : 'codigo=' + t.codigo);

    const dp = (await client.callTool({ name: 'ollyx_depara_sku', arguments: { limite: 1, tempoMaxSeg: 90 } })).structuredContent;
    check(dp.totalProdutos > 0 && dp.kitsPendentes === 0, 'de-para do catálogo Bling', `${dp.totalProdutos} produtos, kits pendentes ${dp.kitsPendentes}${dp.erroConexao ? ', erroConexao=' + dp.erroConexao : ''}`);

    const t0 = Date.now(); let r, calls = 0;
    do {
      calls++;
      const res = await client.callTool({ name: 'ollyx_curva_abc', arguments: { dias: 30, metrica: 'faturamento', classe: 'C', limite: 3, tempoMaxSeg: 60 } }, undefined, { timeout: 290000 });
      r = res.structuredContent;
      if (res.isError) { check(false, 'curva ABC', JSON.stringify(r).slice(0, 160)); return; }
    } while (!r.complete && calls < 5);
    const total = ['A', 'B', 'C'].reduce((s, c) => s + r.resumo[c].faturamento, 0);
    const pct = c => (r.resumo[c].faturamento / total) * 100;
    check(r.complete, 'curva ABC de 30 dias completa', `${r.pedidosPagos} pedidos, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${calls} chamada(s)`);
    check(Math.abs(pct('A') - 80) < 2 && Math.abs(pct('B') - 15) < 2 && Math.abs(pct('C') - 5) < 2, 'classes em 80/15/5 do faturamento', `A ${pct('A').toFixed(1)}% B ${pct('B').toFixed(1)}% C ${pct('C').toFixed(1)}%`);
    const dl = await fetch(r.download);
    check(dl.status === 200 && (await dl.text()).split('\n').length > 10, 'download do CSV pelo link assinado', 'HTTP ' + dl.status);
    check((await fetch(r.download.replace(/sig=.{4}/, 'sig=xxxx'))).status === 403, 'link de download adulterado é recusado');
  } finally { await client.close(); }
}

main().then(() => {
  console.log(failures.length ? `\n${failures.length} VERIFICAÇÃO(ÕES) FALHARAM` : '\nTUDO OK EM PRODUÇÃO');
  process.exitCode = failures.length ? 1 : 0;
}).catch(e => { console.error('ERRO:', e.message); process.exitCode = 1; });
