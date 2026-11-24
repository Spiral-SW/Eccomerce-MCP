import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Servidor OAuth 2.1 próprio do MCP em rede: registro dinâmico de clientes (RFC 7591), authorization code + PKCE S256,
 * refresh com rotação e detecção de reuso. Clientes públicos (sem segredo). Usuários entram com um código de acesso
 * gerado pelo administrador (guardado só como hash). Toda a persistência passa pela interface `db` (ver pg-db.js).
 */
export const sha = value => createHash('sha256').update(value).digest('hex');
const rand = (bytes = 32) => randomBytes(bytes).toString('base64url');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Clientes conhecidos que podem receber o retorno do login: Claude (claude.ai, claude.com) e ChatGPT (chatgpt.com e
// platform.openai.com). Outros destinos exigem OLLYX_REDIRECT_HOSTS. Subdomínios valem; domínios parecidos não.
export const DEFAULT_REDIRECT_HOSTS = Object.freeze(['claude.ai', 'claude.com', 'chatgpt.com', 'openai.com']);
const LOOPBACK =new Set(['localhost', '127.0.0.1', '[::1]']);
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export class OAuthError extends Error {
  constructor(code, description, status = 400, extra = {}) { super(description); this.code = code; this.status = status; this.extra = extra; }
}
const SECURITY = {
  'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
};
const json = (status, body, headers = {}) => ({ status, headers: { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body) });
const html = (status, body) => ({
  status, body,
  headers: { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" },
});
const page = (title, content) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.25rem}input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem}button{cursor:pointer}.e{color:#b00020}small{color:#555}</style></head><body>${content}</body></html>`;

export class OAuthServer {
  constructor({ db, issuer, now = Date.now, accessTtlMs = 3600e3, refreshTtlMs = 30 * 864e5, codeTtlMs = 600e3, maxClients = 10000, allowedHosts = DEFAULT_REDIRECT_HOSTS }) {
    if (!issuer) throw new Error('issuer é obrigatório');
    this.db = db; this.issuer = issuer.replace(/\/$/, ''); this.now = now;
    // Hosts https aceitos como destino do login (e subdomínios). ['*'] ou null aceita qualquer https. Loopback http sempre vale (apps locais).
    this.allowedHosts = allowedHosts && !allowedHosts.includes('*') ? allowedHosts.map(h => h.toLowerCase()) : null;
    this.accessTtlMs = accessTtlMs; this.refreshTtlMs = refreshTtlMs; this.codeTtlMs = codeTtlMs; this.maxClients = maxClients;
  }
  /** Conta a requisição e recusa ao passar do limite (registro e token: abuso de volume). */
  async throttle(bucket, key, limit, windowMs) {
    const hits = await this.db.hit(bucket, sha(String(key)), windowMs, this.now());
    if (hits > limit) throw new OAuthError('too_many_requests', 'Muitas tentativas. Aguarde alguns minutos.', 429);
  }
  /** Recusa se já houve `limit` FALHAS na janela; sucessos não contam (login e administração: força bruta). */
  async assertBelow(bucket, key, limit, windowMs) {
    const failures = await this.db.count(bucket, sha(String(key)), windowMs, this.now());
    if (failures >= limit) throw new OAuthError('too_many_requests', 'Muitas tentativas. Aguarde alguns minutos.', 429);
  }
  async recordFailure(bucket, key, windowMs) { await this.db.hit(bucket, sha(String(key)), windowMs, this.now()); }

  // ---- Metadados (RFC 9728 e RFC 8414) ----
  protectedResource() {
    return json(200, { resource: this.issuer + '/mcp', authorization_servers: [this.issuer], bearer_methods_supported: ['header'], scopes_supported: ['mcp'] });
  }
  metadata() {
    return json(200, {
      issuer: this.issuer, authorization_endpoint: this.issuer + '/authorize', token_endpoint: this.issuer + '/token',
      registration_endpoint: this.issuer + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
      authorization_response_iss_parameter_supported: true,
    });
  }

  // ---- Registro dinâmico de clientes ----
  async register(body, ip = '') {
    await this.throttle('register', ip, 120, 3600e3); // o IP do Claude é compartilhado e ele registra um cliente a cada tentativa de conexão
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'redirect_uris deve ter de 1 a 10 endereços.');
    for (const uri of uris) this.checkRedirectUri(uri);
    if (await this.db.countClients() >= this.maxClients) throw new OAuthError('temporarily_unavailable', 'Limite de clientes atingido.', 503);
    const client = { id: 'oxc_' + rand(18), name: String(body.client_name || 'Cliente MCP').slice(0, 80), redirectUris: uris, createdAt: this.now() };
    await this.db.createClient(client);
    return json(201, {
      client_id: client.id, client_name: client.name, redirect_uris: uris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: Math.floor(client.createdAt / 1000),
    });
  }
  checkRedirectUri(uri) {
    let u;
    try { u = new URL(uri); } catch { throw new OAuthError('invalid_redirect_uri', 'redirect_uri inválido.'); }
    const ok = typeof uri === 'string' && uri.length <= 500 && !u.hash && !u.username && !u.password
      && (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)));
    if (!ok) throw new OAuthError('invalid_redirect_uri', 'redirect_uri precisa ser https (ou http em localhost), sem fragmento.');
    if (u.protocol === 'https:' && this.allowedHosts && !this.allowedHosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) {
      throw new OAuthError('invalid_redirect_uri', 'O destino ' + u.hostname + ' não está autorizado neste servidor.');
    }
  }

  // ---- Tela de autorização ----
  async validateAuthRequest(p) {
    const client = p.client_id ? await this.db.getClient(String(p.client_id)) : null;
    if (!client) throw new OAuthError('invalid_client', 'Cliente desconhecido.');
    if (typeof p.redirect_uri !== 'string' || !client.redirectUris.includes(p.redirect_uri)) throw new OAuthError('invalid_request', 'redirect_uri não registrado para este cliente.');
    const base = { client, redirectUri: p.redirect_uri, state: p.state == null ? undefined : String(p.state).slice(0, 512) };
    const fail = (error, description) => { throw new OAuthError(error, description, 302, { redirect: base }); };
    if (p.response_type !== 'code') fail('unsupported_response_type', 'Somente response_type=code.');
    if (p.code_challenge_method !== 'S256' || !CHALLENGE.test(p.code_challenge || '')) fail('invalid_request', 'PKCE S256 é obrigatório.');
    return { ...base, challenge: p.code_challenge };
  }
  redirectTo(base, params) {
    const url = new URL(base.redirectUri);
    for (const [k, v] of Object.entries({ ...params, state: base.state, iss: this.issuer })) if (v !== undefined) url.searchParams.set(k, v);
    return { status: 302, headers: { ...SECURITY, Location: url.href }, body: '' };
  }
  errorPage(error) {
    return html(error.status === 302 ? 400 : error.status, page('Erro', `<h1>Não foi possível continuar</h1><p class="e">${esc(error.message)}</p>`));
  }
  async authorizeGet(query) {
    try {
      const req = await this.validateAuthRequest(query);
      return html(200, this.form(req, query));
    } catch (error) { return this.handleAuthorizeError(error); }
  }
  form(req, q, message = '') {
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
      .filter(k => q[k] !== undefined).map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
    return page('Entrar', `<h1>Entrar no Ollyx MCP</h1><p><b>${esc(req.client.name)}</b> quer acessar os dados da Ollyx em modo somente leitura.</p>
<p><small>Depois de autorizar, você volta para <b>${esc(new URL(req.redirectUri).host)}</b>. Se não reconhece este endereço, feche a página.</small></p>
<form method="post" action="/authorize">${hidden}<label for="c">Código de acesso</label><input id="c" name="codigo" type="password" autocomplete="off" required autofocus>
${message ? `<p class="e">${esc(message)}</p>` : ''}<button type="submit">Autorizar</button><small>O código é fornecido pelo administrador.</small></form>`);
  }
  handleAuthorizeError(error) {
    if (!(error instanceof OAuthError)) throw error;
    if (error.extra.redirect) return this.redirectTo(error.extra.redirect, { error: error.code, error_description: error.message });
    return this.errorPage(error);
  }
  async authorizePost(form, ip = '') {
    let req;
    try {
      req = await this.validateAuthRequest(form);
      await this.assertBelow('authorize', ip, 10, 600e3);
      const codigo = String(form.codigo || '').trim();
      const user = codigo ? await this.db.findUserByCodeHash(sha(codigo)) : null;
      if (!user || !user.ativo) {
        await this.recordFailure('authorize', ip, 600e3);
        return html(401, this.form(req, form, 'Código de acesso inválido.'));
      }
      const code = rand();
      await this.db.saveAuthCode({ hash: sha(code), clientId: req.client.id, userId: user.id, redirectUri: req.redirectUri, challenge: req.challenge, expiresAt: this.now() + this.codeTtlMs });
      return this.redirectTo(req, { code });
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'too_many_requests') return html(429, page('Aguarde', `<h1>Muitas tentativas</h1><p class="e">${esc(error.message)}</p>`));
      return this.handleAuthorizeError(error);
    }
  }

  // ---- Endpoint de token ----
  async issueTokens({ clientId, userId, familyId = rand(12) }) {
    const access = 'oxa_' + rand(), refresh = 'oxr_' + rand(), t = this.now();
    await this.db.saveToken({ hash: sha(access), kind: 'access', clientId, userId, familyId, expiresAt: t + this.accessTtlMs });
    await this.db.saveToken({ hash: sha(refresh), kind: 'refresh', clientId, userId, familyId, expiresAt: t + this.refreshTtlMs });
    return json(200, { access_token: access, token_type: 'Bearer', expires_in: Math.floor(this.accessTtlMs / 1000), refresh_token: refresh, scope: 'mcp' });
  }
  async token(body, ip = '') {
    try {
      await this.throttle('token', ip, 120, 600e3);
      const clientId = String(body.client_id || '');
      if (!clientId || !(await this.db.getClient(clientId))) throw new OAuthError('invalid_client', 'Cliente desconhecido.', 401);
      if (body.grant_type === 'authorization_code') {
        const rec = await this.db.takeAuthCode(sha(String(body.code || '')));
        const bad = () => new OAuthError('invalid_grant', 'Código de autorização inválido ou expirado.');
        if (!rec || rec.expiresAt <= this.now() || rec.clientId !== clientId || rec.redirectUri !== body.redirect_uri) throw bad();
        const verifier = String(body.code_verifier || '');
        if (!VERIFIER.test(verifier)) throw bad();
        const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url')), b = Buffer.from(rec.challenge);
        if (a.length !== b.length || !timingSafeEqual(a, b)) throw bad();
        return await this.issueTokens({ clientId, userId: rec.userId });
      }
      if (body.grant_type === 'refresh_token') {
        const taken = await this.db.takeRefresh(sha(String(body.refresh_token || '')));
        if (taken.status === 'reused') { await this.db.revokeFamily(taken.token.familyId); throw new OAuthError('invalid_grant', 'Refresh token já utilizado; sessão revogada.'); }
        const rec = taken.token;
        if (taken.status !== 'ok' || rec.clientId !== clientId || rec.expiresAt <= this.now()) throw new OAuthError('invalid_grant', 'Refresh token inválido ou expirado.');
        return await this.issueTokens({ clientId, userId: rec.userId, familyId: rec.familyId });
      }
      throw new OAuthError('unsupported_grant_type', 'grant_type não suportado.');
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      return json(error.status === 302 ? 400 : error.status, { error: error.code, error_description: error.message });
    }
  }

  // ---- Validação do bearer no recurso /mcp ----
  async authenticate(header) {
    const m = /^Bearer (oxa_[A-Za-z0-9_-]{20,})$/.exec(header || '');
    if (!m) return null;
    const rec = await this.db.getAccessToken(sha(m[1]));
    if (!rec || rec.expiresAt <= this.now() || rec.revoked || !rec.user?.ativo) return null;
    return { userId: rec.userId, nome: rec.user.nome, papel: rec.user.papel, clientId: rec.clientId };
  }
  unauthorized() {
    return json(401, { error: 'unauthorized', error_description: 'Autenticação necessária.' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource"`,
    });
  }
}
