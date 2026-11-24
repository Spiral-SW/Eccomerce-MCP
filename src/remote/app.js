import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Analytics } from '../analytics.js';
import { Depara } from '../depara.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../server.js';
import { ApiClient } from '../client.js';
import { authorizationRequest } from '../auth-cli.js';
import { grantToken } from '../tokens.js';
import { OllyxError, publicError } from '../errors.js';
import { OAuthError, sha } from './oauth.js';

const MAX_BODY = 256 * 1024;
const PROVIDERS = new Set(['bling', 'meli']);
const SECURITY = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => ({ status: 200, headers: { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" },
  body: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1rem}input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem}.e{color:#b00020}</style></head><body>${body}</body></html>` });

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new OAuthError('invalid_request', 'Corpo da requisição grande demais.', 413);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (!text) return {};
  try {
    if (type.includes('application/json')) return JSON.parse(text);
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  } catch { throw new OAuthError('invalid_request', 'Corpo inválido.'); }
  throw new OAuthError('invalid_request', 'Content-Type não suportado.', 415);
}
const clientIp = req => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '').trim();
function send(res, r) {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
  res.end(r.body ?? '');
}

/** Assinatura HMAC dos links de download (o navegador não envia o bearer ao clicar num link). */
export function exportSigner({ key, issuer, ttlMs = 3600e3, now = Date.now }) {
  const mac = (name, exp) => createHmac('sha256', key).update(`export|${name}|${exp}`).digest('base64url');
  return {
    sign: name => { const exp = now() + ttlMs; return `${issuer}/api/exports/${encodeURIComponent(name)}?exp=${exp}&sig=${mac(name, exp)}`; },
    verify: (name, exp, sig) => {
      const a = Buffer.from(String(sig || '')), b = Buffer.from(mac(name, exp));
      return Number(exp) > now() && a.length === b.length && timingSafeEqual(a, b);
    },
  };
}

/**
 * Aplicação HTTP do MCP em rede (Vercel Functions ou qualquer Node). Sem estado: cada requisição /mcp cria seu
 * próprio servidor MCP; cache, tokens e sessões OAuth vivem no Postgres.
 */
export function createApp({ config, oauth, tokens, store, signer, fetchImpl = fetch, cronSecret = '', client: injectedClient }) {
  const client = injectedClient || new ApiClient(config, tokens); // único por processo: mantém o ritmo de chamadas às APIs
  const issuer = oauth.issuer;

  async function mcp(req, res, url) {
    const user = await oauth.authenticate(req.headers.authorization);
    if (!user) return send(res, oauth.unauthorized());
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    // para o registro de acesso: método JSON-RPC e nome da ferramenta (nunca os argumentos)
    const one = Array.isArray(body) ? body[0] : body;
    req.rpc = one?.method ? one.method + (one.params?.name ? ':' + String(one.params.name).slice(0, 40) : '') + (Array.isArray(body) ? `+${body.length - 1}` : '') : undefined;
    const server = createServer({ config, tokens, client, store });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /**
   * Tarefa diária (Vercel Cron): mantém o banco ativo (o plano gratuito do Supabase pausa projetos parados), renova os
   * tokens antes de a cadeia de refresh expirar e aquece o catálogo e os pedidos recentes, para a primeira consulta do
   * dia não pagar a leitura a frio. Cada etapa é independente: uma falha não impede as outras.
   */
  async function daily() {
    const etapas = {};
    const step = async (nome, fn) => {
      const t0 = Date.now();
      try { etapas[nome] = { ok: true, ...(await fn()), ms: Date.now() - t0 }; }
      catch (error) { etapas[nome] = { ok: false, erro: publicError(error).code, ms: Date.now() - t0 }; }
    };
    await step('banco', async () => { await store.get('ping'); return {}; });
    for (const provider of ['bling', 'meli']) {
      await step('token-' + provider, async () => ({ resultado: tokens.refreshNow ? await tokens.refreshNow(provider) : 'indisponivel' }));
    }
    await step('catalogo', async () => {
      const c = await new Depara(client, { store }).catalogo({ atualizar: true, tempoMaxMs: 100000 });
      return { produtos: c.rows.length, kitsPendentes: c.kitsPendentes };
    });
    await step('pedidos', async () => {
      const r = await new Analytics(client, { store }).curvaAbc({ dias: 35, custos: false, exportar: false, renovar: true, tempoMaxMs: 100000 });
      return { dias: r.diasProcessados, diasPendentes: r.diasPendentes.length, pedidos: r.pedidosPagos };
    });
    await step('limpeza', async () => (await oauth.db.purgeStale?.()) ?? { apagadas: 0 }); // retenção: nada de pedidos com mais de 25 h
    const resultado = { ok: Object.values(etapas).every(e => e.ok), etapas };
    console.log('[ollyx] tarefa diária: ' + JSON.stringify(resultado));
    return resultado;
  }
  const cronAuthorized = req => {
    if (!cronSecret) return false;
    const a = createHash('sha256').update(String(req.headers.authorization || '')).digest();
    const b = createHash('sha256').update('Bearer ' + cronSecret).digest();
    return timingSafeEqual(a, b);
  };

  async function download(req, res, url, name) {
    const exp = url.searchParams.get('exp'), sig = url.searchParams.get('sig');
    if (!signer.verify(name, exp, sig)) return send(res, { status: 403, headers: SECURITY, body: 'Link inválido ou expirado.' });
    const text = await store.getExport(name);
    if (text == null) return send(res, { status: 404, headers: SECURITY, body: 'Exportação não encontrada ou expirada.' });
    send(res, { status: 200, headers: { ...SECURITY, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"` }, body: text });
  }

  async function adminConnect(req, res, provider) {
    const cfg = config.providers[provider];
    if (req.method === 'GET') {
      return send(res, page('Conectar ' + provider, `<h1>Conectar ${esc(provider)}</h1><form method="post"><label for="c">Código de administrador</label><input id="c" name="codigo" type="password" autocomplete="off" required autofocus><button>Continuar</button></form>`));
    }
    const form = await readBody(req);
    await oauth.assertBelow('admin', clientIp(req), 10, 600e3);
    const user = await oauth.db.findUserByCodeHash(sha(String(form.codigo || '').trim()));
    if (!user || !user.ativo || user.papel !== 'admin') {
      await oauth.recordFailure('admin', clientIp(req), 600e3);
      return send(res, { ...page('Acesso negado', '<h1>Acesso negado</h1><p class="e">Código inválido ou sem permissão de administrador.</p>'), status: 403 });
    }
    const request = authorizationRequest(provider, { ...cfg, redirectUri: `${issuer}/admin/callback/${provider}` });
    await store.set('oauthstate.' + sha(request.state), { provider, verifier: request.verifier }, { ttlMs: 600e3 });
    send(res, { status: 302, headers: { ...SECURITY, Location: request.url }, body: '' });
  }
  async function adminCallback(req, res, url, provider) {
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    const key = 'oauthstate.' + sha(state);
    const saved = state ? await store.get(key) : null;
    if (saved) await store.del(key); // uso único
    const fail = (status, motivo) => { // mensagem segura: só códigos curtos, nunca tokens, códigos de autorização ou state
      console.error(`[ollyx] conexão ${provider} falhou: ${motivo}`);
      return send(res, { ...page('Falha', `<h1>Não foi possível conectar</h1><p class="e">${esc(motivo)}</p><p>Comece de novo em /admin/connect/${esc(provider)}.</p>`), status });
    };
    const providerError = (url.searchParams.get('error') || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
    if (providerError) return fail(400, `O provedor recusou a autorização (${providerError}).`);
    if (!saved || saved.provider !== provider) return fail(400, 'Sessão de conexão inválida ou expirada (cada link vale uma vez e por 10 minutos).');
    if (!code) return fail(400, 'O provedor não devolveu o código de autorização.');
    const cfg = config.providers[provider];
    const form = { grant_type: 'authorization_code', code, redirect_uri: `${issuer}/admin/callback/${provider}` };
    if (provider === 'meli') form.code_verifier = saved.verifier;
    let token;
    try { token = await grantToken(provider, cfg, form, fetchImpl, config.timeoutMs); }
    catch (error) {
      const e = publicError(error);
      return fail(502, `A troca do código por token falhou (${e.code}${e.status ? ', HTTP ' + e.status : ''}). Confira o Client ID, o Client Secret e o link de redirecionamento do aplicativo.`);
    }
    await tokens.save(provider, token);
    send(res, page('Conectado', `<h1>${esc(provider)} conectado</h1><p>Pode fechar esta página. Nenhum token foi exibido.</p>`));
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, issuer);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const m = req.method;
      const started = Date.now();
      if (path !== '/health') { // registro de acesso: só método, caminho (sem query), status, tempo e cliente; nunca tokens nem códigos
        res.on('finish', () => console.log(`[ollyx] ${m} ${path} ${res.statusCode} ${Date.now() - started}ms rpc=${req.rpc || '-'} ua=${String(req.headers['user-agent'] || '-').slice(0, 60)} origem=${req.headers.origin || '-'}`));
      }
      // CORS só nos endpoints públicos do protocolo (metadados, registro, token e /mcp): clientes web do MCP precisam disso.
      // Sem cookies nem credenciais; o token exige PKCE. As páginas de login e de administração ficam fora.
      if (path.startsWith('/.well-known/') || path === '/register' || path === '/token' || path === '/mcp') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
        res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
        res.setHeader('Access-Control-Max-Age', '86400');
        if (m === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      }
      if (path === '/health') return send(res, { status: 200, headers: SECURITY, body: 'ok' });
      if (m === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) return send(res, oauth.protectedResource());
      if (m === 'GET' && path === '/.well-known/oauth-authorization-server') return send(res, oauth.metadata());
      if (path === '/register' && m === 'POST') return send(res, await oauth.register(await readBody(req), clientIp(req)));
      if (path === '/authorize' && m === 'GET') return send(res, await oauth.authorizeGet(Object.fromEntries(url.searchParams)));
      if (path === '/authorize' && m === 'POST') return send(res, await oauth.authorizePost(await readBody(req), clientIp(req)));
      if (path === '/token' && m === 'POST') return send(res, await oauth.token(await readBody(req), clientIp(req)));
      if (path === '/mcp') return await mcp(req, res, url);
      if (path === '/api/cron/daily' && m === 'GET') {
        if (!cronSecret) return send(res, { status: 404, headers: SECURITY, body: 'Não encontrado.' }); // sem segredo configurado a rota nem existe
        if (!cronAuthorized(req)) return send(res, { status: 401, headers: SECURITY, body: 'Não autorizado.' });
        const r = await daily();
        return send(res, { status: r.ok ? 200 : 207, headers: { ...SECURITY, 'Content-Type': 'application/json' }, body: JSON.stringify(r) });
      }
      let r;
      if (m === 'GET' && (r = /^\/api\/exports\/([^/]+)$/.exec(path))) return await download(req, res, url, decodeURIComponent(r[1]));
      if ((r = /^\/admin\/connect\/(bling|meli)$/.exec(path)) && (m === 'GET' || m === 'POST')) return await adminConnect(req, res, r[1]);
      if (m === 'GET' && (r = /^\/admin\/callback\/(bling|meli)$/.exec(path))) return await adminCallback(req, res, url, r[1]);
      send(res, { status: 404, headers: SECURITY, body: 'Não encontrado.' });
    } catch (error) {
      if (error instanceof OAuthError) return send(res, { status: error.status === 302 ? 400 : error.status, headers: { ...SECURITY, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.code, error_description: error.message }) });
      if (process.env.OLLYX_DEBUG) console.error('[ollyx]', error?.stack || error);
      if (!res.headersSent) send(res, { status: 500, headers: { ...SECURITY, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: publicError(error) }) });
      else res.end();
    }
  };
}
