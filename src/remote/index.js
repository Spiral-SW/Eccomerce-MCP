import pg from 'pg';
import connectionString from 'pg-connection-string';
import { loadConfig } from '../config.js';
import { OllyxError } from '../errors.js';
import { PgStore } from '../store.js';
import { OAuthServer } from './oauth.js';
import { PgOAuthDb } from './pg-db.js';
import { PgTokenManager, parseKey } from './provider-tokens.js';
import { createApp, exportSigner } from './app.js';

export function publicUrl(env) {
  const raw = env.OLLYX_PUBLIC_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL : '');
  if (!/^https:\/\/[^/]+$/.test(raw.replace(/\/$/, ''))) throw new OllyxError('invalid_public_url', 'Defina OLLYX_PUBLIC_URL com o endereço https público do serviço (sem caminho).');
  return raw.replace(/\/$/, '');
}

/** Monta a aplicação a partir de variáveis de ambiente (Vercel). Nenhum arquivo .env é necessário. */
export function buildFromEnv(env = process.env) {
  const config = loadConfig(env, false);
  if (!config.databaseUrl) throw new OllyxError('missing_database', 'Defina OLLYX_DATABASE_URL (connection string do Postgres/Supabase).');
  const issuer = publicUrl(env);
  const key = parseKey(env.OLLYX_TOKEN_KEY);
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000,
    ssl: local ? false : { rejectUnauthorized: false }, // criptografado; sem verificação de cadeia (o pooler do Supabase usa CA própria)
  });
  if (env.OLLYX_DEBUG) { // só formato, destino e usuário, nunca a senha: ajuda a achar connection string mal colada
    const raw = config.databaseUrl;
    try {
      const o = connectionString.parse(raw);
      console.error(`[ollyx] banco: comprimento=${raw.length} esquema_ok=${/^postgres(ql)?:\/\//.test(raw)} arrobas=${(raw.match(/@/g) || []).length} host=${o.host} porta=${o.port} usuario=${o.user} banco=${o.database} senha=${o.password ? o.password.length + ' caracteres' : 'ausente'}`);
    } catch (e) { console.error(`[ollyx] banco: string ilegível (${e.message.slice(0, 60)}); comprimento=${raw.length}`); }
  }
  const signer = exportSigner({ key, issuer });
  const store = new PgStore(pool, { signer: signer.sign });
  const tokens = new PgTokenManager(config, { pool, store, key });
  const hosts = env.OLLYX_REDIRECT_HOSTS?.trim() ? env.OLLYX_REDIRECT_HOSTS.split(',').map(h => h.trim()).filter(Boolean) : undefined; // padrão: claude.ai e claude.com
  const oauth = new OAuthServer({ db: new PgOAuthDb(pool), issuer, allowedHosts: hosts });
  return createApp({ config, oauth, tokens, store, signer, cronSecret: env.CRON_SECRET?.trim() || '' });
}
