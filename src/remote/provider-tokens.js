import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { OllyxError } from '../errors.js';
import { grantToken } from '../tokens.js';

const b64 = b => Buffer.from(b).toString('base64url');
const MEMORY_MS = 30000; // curto de propósito: uma reconexão feita por um administrador vale em até 30 s em todas as instâncias

/** AES-256-GCM; a chave (32 bytes em base64) vem de OLLYX_TOKEN_KEY e nunca é gravada no banco. */
export function parseKey(value) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw new OllyxError('invalid_token_key', 'OLLYX_TOKEN_KEY deve ser 32 bytes em base64 (gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").');
  return key;
}
export function encrypt(plain, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', b64(iv), b64(cipher.getAuthTag()), b64(data)].join('.');
}
export function decrypt(text, key) {
  const [v, iv, tag, data] = String(text).split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new OllyxError('invalid_ciphertext', 'Token cifrado em formato inesperado.');
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch { throw new OllyxError('decrypt_failed', 'Não foi possível decifrar o token (chave OLLYX_TOKEN_KEY incorreta?).'); }
}

/**
 * Gerenciador de tokens dos provedores guardados no Postgres, com a mesma interface de TokenManager
 * (source/get). Renova o token sob trava consultiva, então várias instâncias serverless nunca renovam
 * ao mesmo tempo (os provedores rotacionam o refresh token: duas renovações simultâneas quebrariam a conexão).
 */
export class PgTokenManager {
  constructor(config, { pool, store, key, fetchImpl = fetch, now = Date.now } = {}) {
    this.config = config; this.pool = pool; this.store = store; this.key = key; this.fetch = fetchImpl; this.now = now;
    this.mem = new Map();
  }
  async read(provider) {
    const r = (await this.pool.query(
      'SELECT access_token_enc, refresh_token_enc, (extract(epoch from expires_at) * 1000)::bigint AS expires_at FROM mcp.provider_tokens WHERE provider = $1', [provider])).rows[0];
    if (!r) return null;
    return { access_token: decrypt(r.access_token_enc, this.key), refresh_token: decrypt(r.refresh_token_enc, this.key), expires_at: Number(r.expires_at) };
  }
  async save(provider, token) {
    await this.pool.query(
      `INSERT INTO mcp.provider_tokens (provider, access_token_enc, refresh_token_enc, expires_at, scope, updated_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, now())
       ON CONFLICT (provider) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope, updated_at = now()`,
      [provider, encrypt(token.access_token, this.key), encrypt(token.refresh_token || '', this.key), token.expires_at, token.scope || '']);
  }
  async source(provider) { return (await this.pool.query('SELECT 1 FROM mcp.provider_tokens WHERE provider = $1', [provider])).rows.length ? 'oauth_database' : 'not_configured'; }
  /** Guarda o token válido na memória do processo por pouco tempo: evita uma ida ao banco a cada chamada às APIs. */
  remember(provider, t) { this.mem.set(provider, { token: t.access_token, expires_at: Number(t.expires_at), until: this.now() + MEMORY_MS }); return t.access_token; }
  /**
   * Renova agora, mesmo com o token ainda válido. A tarefa diária usa isto para manter viva a cadeia de refresh:
   * Bling e Mercado Livre expiram o refresh token se ninguém renovar por semanas, e aí seria preciso reconectar.
   */
  async refreshNow(provider) {
    const current = await this.read(provider);
    if (!current) return 'not_configured';
    this.mem.delete(provider);
    await this.get(provider, current.access_token); // token "recusado" força o caminho de renovação sob trava
    return 'renovado';
  }
  async get(provider, staleToken = null) {
    const fresh = t => t && Number(t.expires_at) > this.now() + 60000 && t.access_token !== staleToken;
    const hot = this.mem.get(provider); // token recusado (staleToken) ignora a memória e vai ao banco
    if (hot && hot.until > this.now() && hot.expires_at > this.now() + 60000 && hot.token !== staleToken) return hot.token;
    const current = await this.read(provider);
    if (!current) { this.mem.delete(provider); throw new OllyxError('not_configured', 'Provedor ainda não conectado. Um administrador deve abrir /admin/connect/' + provider + '.'); }
    if (fresh(current)) return this.remember(provider, current);
    return this.store.withLock('refresh:' + provider, async () => {
      const again = await this.read(provider); // outra instância pode ter renovado enquanto esperávamos a trava
      if (fresh(again)) return this.remember(provider, again);
      const cfg = this.config.providers[provider];
      if (!again?.refresh_token || !cfg.clientId || !cfg.clientSecret) throw new OllyxError('reconnect_required', 'Reconecte o provedor em /admin/connect/' + provider + '.');
      let refreshed;
      try { refreshed = await grantToken(provider, cfg, { grant_type: 'refresh_token', refresh_token: again.refresh_token }, this.fetch, this.config.timeoutMs); }
      catch (error) {
        if (error instanceof OllyxError && error.code === 'oauth_failed') throw new OllyxError('reconnect_required', 'O provedor recusou a renovação. Reconecte em /admin/connect/' + provider + '.', error.extra);
        throw error;
      }
      await this.save(provider, refreshed);
      return this.remember(provider, refreshed);
    });
  }
}
