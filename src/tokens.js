import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { OllyxError } from './errors.js';
import { readLimited } from './io.js';

export const oauth = Object.freeze({
  bling: { authorize: 'https://www.bling.com.br/Api/v3/oauth/authorize', token: 'https://api.bling.com.br/Api/v3/oauth/token' },
  meli: { authorize: 'https://auth.mercadolivre.com.br/authorization', token: 'https://api.mercadolibre.com/oauth/token' },
});
export async function loadToken(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value.access_token || typeof value.access_token !== 'string') throw new Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new OllyxError('invalid_token_file', 'Arquivo OAuth ausente, inválido ou inacessível.');
  }
}
export async function saveToken(path, token) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(token, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
export async function withFileLock(path, action) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = path + '.lock';
  let handle;
  for (let i = 0; i < 100; i++) {
    try { handle = await open(lockPath, 'wx', 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await delay(100); }
  }
  if (!handle) throw new OllyxError('oauth_busy', 'Outra instância está renovando o OAuth. Aguarde. Se houve queda, remova o .lock após encerrar as instâncias.');
  try { return await action(); }
  finally { await handle.close(); await unlink(lockPath).catch(() => {}); }
}
export async function grantToken(provider, config, form, fetchImpl = fetch, timeoutMs = 20000) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(form);
  if (provider === 'bling') {
    headers.Authorization = 'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64');
    headers['enable-jwt'] = '1';
  }
  else { body.set('client_id', config.clientId); body.set('client_secret', config.clientSecret); }
  let response;
  try {
    response = await fetchImpl(oauth[provider].token, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OllyxError('oauth_failed', 'A API recusou a autorização ou renovação. Reconecte localmente.', { status: response.status });
    }
    const data = JSON.parse((await readLimited(response, 65536)).toString('utf8'));
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new Error();
    return {
      access_token: data.access_token, refresh_token: data.refresh_token || form.refresh_token || '',
      expires_at: Date.now() + Number(data.expires_in) * 1000,
      scope: typeof data.scope === 'string' ? data.scope : '',
      user_id: data.user_id == null ? null : String(data.user_id),
    };
  } catch (error) {
    if (error instanceof OllyxError) throw error;
    throw new OllyxError('oauth_unavailable', 'Não foi possível concluir o OAuth. Verifique conexão e configuração.');
  }
}
export class TokenManager {
  constructor(config, { fetchImpl = fetch, databaseReader } = {}) {
    this.config = config; this.fetch = fetchImpl; this.databaseReader = databaseReader;
  }
  async source(provider) {
    const config = this.config.providers[provider];
    if (config.accessToken) return 'environment';
    if (config.sharedEnvFile) return 'shared_connection_read_only';
    if (config.useDatabase) return 'ollyx_database_read_only';
    return (await loadToken(config.tokenFile)) ? 'oauth_file' : 'not_configured';
  }
  async sharedToken(provider, staleToken) {
    const config = this.config.providers[provider];
    try {
      const source = parseEnv(await readFile(config.sharedEnvFile));
      const cacheName = source[provider === 'bling' ? 'BLING_TOKEN_CACHE_FILE' : 'TOKEN_CACHE_FILE'];
      let cache = {};
      if (cacheName) {
        try { cache = JSON.parse((await readFile(resolve(dirname(config.sharedEnvFile), cacheName), 'utf8')).replace(/^\uFEFF/, '')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const access = cache.access_token || source[provider === 'bling' ? 'BLING_ACCESS_TOKEN' : 'ACCESS_TOKEN'];
      const rawExpiry = cache.expires_at;
      const numeric = typeof rawExpiry === 'number' || (typeof rawExpiry === 'string' && /^\d+(\.\d+)?$/.test(rawExpiry));
      const expiry = numeric ? Number(rawExpiry) * (Number(rawExpiry) < 1e12 ? 1000 : 1) : Date.parse(rawExpiry);
      if (!access || typeof access !== 'string' || (rawExpiry != null && (!Number.isFinite(expiry) || expiry <= Date.now() + 60000)) || access === staleToken) {
        throw new OllyxError('reconnect_required', 'A conexão de origem precisa renovar o token. O MCP só lê o cache e não o altera.');
      }
      return access;
    } catch (error) {
      if (error instanceof OllyxError) throw error;
      throw new OllyxError('shared_connection_unavailable', 'Não foi possível ler a conexão compartilhada. Verifique os caminhos locais.');
    }
  }
  async databaseToken(provider) {
    if (!this.config.databaseUrl) throw new OllyxError('missing_database', 'Configure OLLYX_DATABASE_URL localmente.');
    if (this.databaseReader) return this.databaseReader(provider);
    const client = new pg.Client({
      connectionString: this.config.databaseUrl, connectionTimeoutMillis: 10000, query_timeout: 10000,
      options: '-c default_transaction_read_only=on -c statement_timeout=10000',
    });
    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      const result = await client.query(
        'SELECT access_token, expires_at FROM oauth_tokens WHERE provider = $1 LIMIT 1',
        [provider === 'meli' ? 'mercado_livre' : 'bling'],
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      return row ? { access_token: row.access_token, expires_at: new Date(row.expires_at).getTime() } : null;
    } catch {
      throw new OllyxError('database_unavailable', 'Não foi possível ler o OAuth no banco da Ollyx.');
    } finally { await client.end().catch(() => {}); }
  }
  async get(provider, staleToken = null) {
    const config = this.config.providers[provider];
    if (config.accessToken) {
      if (staleToken) throw new OllyxError('reconnect_required', 'O token de ambiente foi recusado. Atualize-o localmente.');
      return config.accessToken;
    }
    if (config.sharedEnvFile) return this.sharedToken(provider, staleToken);
    if (config.useDatabase) {
      const token = await this.databaseToken(provider);
      if (!token?.access_token || !Number.isFinite(token.expires_at) || token.expires_at <= Date.now() + 60000
        || (staleToken && token.access_token === staleToken)) {
        throw new OllyxError('reconnect_required', 'A Ollyx precisa renovar ou reconectar esta integração. O MCP não altera tokens compartilhados.');
      }
      return token.access_token;
    }
    const token = await loadToken(config.tokenFile);
    if (!token) throw new OllyxError('not_configured', 'Conecte o provedor localmente usando npm run auth ou configure um token/banco.');
    if (!staleToken && Number(token.expires_at) > Date.now() + 60000) return token.access_token;
    return withFileLock(config.tokenFile, async () => {
      const current = await loadToken(config.tokenFile);
      if (Number(current?.expires_at) > Date.now() + 60000 && (!staleToken || current.access_token !== staleToken)) return current.access_token;
      if (!current?.refresh_token || !config.clientId || !config.clientSecret) throw new OllyxError('reconnect_required', 'Configure as credenciais OAuth e reconecte o provedor localmente.');
      const refreshed = await grantToken(provider, config, {
        grant_type: 'refresh_token', refresh_token: current.refresh_token,
      }, this.fetch, this.config.timeoutMs);
      await saveToken(config.tokenFile, refreshed);
      return refreshed.access_token;
    });
  }
}
