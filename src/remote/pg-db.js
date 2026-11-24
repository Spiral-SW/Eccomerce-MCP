/** Implementação Postgres da interface `db` usada por OAuthServer (ver test/helpers/fake-oauth-db.js). Schema: sql/001_mcp_remote.sql. */
const ms = column => `(extract(epoch from ${column}) * 1000)::bigint`;
const num = v => (v == null ? v : Number(v));

export class PgOAuthDb {
  constructor(pool) { this.pool = pool; }
  q(text, params) { return this.pool.query(text, params); }

  async countClients() { return Number((await this.q('SELECT count(*) AS n FROM mcp.clients')).rows[0].n); }
  async createClient(c) {
    await this.q('INSERT INTO mcp.clients (id, name, redirect_uris) VALUES ($1, $2, $3::jsonb)', [c.id, c.name, JSON.stringify(c.redirectUris)]);
  }
  async getClient(id) {
    const r = (await this.q('SELECT id, name, redirect_uris FROM mcp.clients WHERE id = $1', [id])).rows[0];
    return r ? { id: r.id, name: r.name, redirectUris: r.redirect_uris } : null;
  }
  async findUserByCodeHash(hash) {
    const r = (await this.q('SELECT id, nome, papel, ativo FROM mcp.users WHERE code_hash = $1', [hash])).rows[0];
    return r || null;
  }
  async saveAuthCode(c) {
    await this.q(
      'INSERT INTO mcp.auth_codes (hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))',
      [c.hash, c.clientId, c.userId, c.redirectUri, c.challenge, c.expiresAt]);
  }
  /** Consome o código de forma atômica: dois pedidos simultâneos nunca recebem o mesmo código. */
  async takeAuthCode(hash) {
    const r = (await this.q(
      `DELETE FROM mcp.auth_codes WHERE hash = $1 RETURNING client_id, user_id, redirect_uri, challenge, ${ms('expires_at')} AS expires_at`, [hash])).rows[0];
    return r ? { clientId: r.client_id, userId: r.user_id, redirectUri: r.redirect_uri, challenge: r.challenge, expiresAt: num(r.expires_at) } : null;
  }
  async saveToken(t) {
    await this.q(
      'INSERT INTO mcp.tokens (hash, kind, client_id, user_id, family_id, expires_at) VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))',
      [t.hash, t.kind, t.clientId, t.userId, t.familyId, t.expiresAt]);
    if (Math.random() < 0.02) await this.cleanup();
  }
  async getAccessToken(hash) {
    const r = (await this.q(
      `SELECT t.client_id, t.user_id, t.revoked, ${ms('t.expires_at')} AS expires_at, u.nome, u.papel, u.ativo
         FROM mcp.tokens t JOIN mcp.users u ON u.id = t.user_id WHERE t.hash = $1 AND t.kind = 'access'`, [hash])).rows[0];
    return r ? { clientId: r.client_id, userId: r.user_id, revoked: r.revoked, expiresAt: num(r.expires_at), user: { nome: r.nome, papel: r.papel, ativo: r.ativo } } : null;
  }
  /** Marca o refresh como usado de forma atômica. Se já estava usado/revogado, devolve 'reused' (sinal de roubo). */
  async takeRefresh(hash) {
    const cols = `client_id, user_id, family_id, ${ms('expires_at')} AS expires_at`;
    const map = r => ({ clientId: r.client_id, userId: r.user_id, familyId: r.family_id, expiresAt: num(r.expires_at) });
    const took = (await this.q(
      `UPDATE mcp.tokens SET used_at = now() WHERE hash = $1 AND kind = 'refresh' AND used_at IS NULL AND NOT revoked RETURNING ${cols}`, [hash])).rows[0];
    if (took) return { status: 'ok', token: map(took) };
    const seen = (await this.q(`SELECT ${cols} FROM mcp.tokens WHERE hash = $1 AND kind = 'refresh'`, [hash])).rows[0];
    return seen ? { status: 'reused', token: map(seen) } : { status: 'missing' };
  }
  async revokeFamily(familyId) { await this.q('UPDATE mcp.tokens SET revoked = true WHERE family_id = $1', [familyId]); }
  async hit(bucket, key, windowMs, now) {
    await this.q('INSERT INTO mcp.hits (bucket, key, at) VALUES ($1, $2, to_timestamp($3 / 1000.0))', [bucket, key, now]);
    const r = await this.q('SELECT count(*) AS n FROM mcp.hits WHERE bucket = $1 AND key = $2 AND at > to_timestamp($3 / 1000.0)', [bucket, key, now - windowMs]);
    return Number(r.rows[0].n);
  }
  async count(bucket, key, windowMs, now) {
    const r = await this.q('SELECT count(*) AS n FROM mcp.hits WHERE bucket = $1 AND key = $2 AND at > to_timestamp($3 / 1000.0)', [bucket, key, now - windowMs]);
    return Number(r.rows[0].n);
  }
  /**
   * Rede de segurança da retenção (cláusula 2.2.1.3 dos Termos do ML): apaga cópias vencidas e QUALQUER cópia de pedidos ou
   * exportação com mais de 25 h, mesmo que tenha sido gravada sem validade. Devolve quantas cópias foram apagadas.
   */
  async purgeStale() {
    const r = await this.q(
      `DELETE FROM mcp.kv WHERE (expires_at IS NOT NULL AND expires_at < now())
         OR ((key LIKE 'orders2-%' OR key LIKE 'export.%') AND updated_at < now() - interval '25 hours') RETURNING 1`);
    return { apagadas: r.rowCount };
  }
  async cleanup() {
    await this.q("DELETE FROM mcp.hits WHERE at < now() - interval '1 day'").catch(() => {});
    await this.q("DELETE FROM mcp.tokens WHERE expires_at < now() - interval '7 days'").catch(() => {});
    await this.q('DELETE FROM mcp.auth_codes WHERE expires_at < now()').catch(() => {});
    await this.purgeStale().catch(() => {});
  }
}
