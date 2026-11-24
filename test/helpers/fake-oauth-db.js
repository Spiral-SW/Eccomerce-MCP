/** Banco em memória com a mesma interface de src/remote/pg-db.js; usado só nos testes. */
export class FakeOAuthDb {
  constructor() { this.clients = new Map(); this.users = new Map(); this.codes = new Map(); this.tokens = new Map(); this.hits = []; }
  addUser(user) { this.users.set(user.codeHash, user); return user; }
  async countClients() { return this.clients.size; }
  async createClient(c) { this.clients.set(c.id, c); }
  async getClient(id) { return this.clients.get(id) || null; }
  async findUserByCodeHash(h) { return this.users.get(h) || null; }
  async saveAuthCode(r) { this.codes.set(r.hash, r); }
  async takeAuthCode(h) { const r = this.codes.get(h) || null; this.codes.delete(h); return r; }
  async saveToken(t) { this.tokens.set(t.hash, { ...t, used: false, revoked: false }); }
  async getAccessToken(h) {
    const t = this.tokens.get(h);
    if (!t || t.kind !== 'access') return null;
    return { ...t, user: [...this.users.values()].find(u => u.id === t.userId) || null };
  }
  async takeRefresh(h) {
    const t = this.tokens.get(h);
    if (!t || t.kind !== 'refresh') return { status: 'missing' };
    if (t.used || t.revoked) return { status: 'reused', token: t };
    t.used = true; return { status: 'ok', token: t };
  }
  async revokeFamily(f) { for (const t of this.tokens.values()) if (t.familyId === f) t.revoked = true; }
  async count(bucket, key, windowMs, now) {
    return this.hits.filter(h => h.bucket === bucket && h.key === key && h.now > now - windowMs).length;
  }
  async hit(bucket, key, windowMs, now) {
    this.hits.push({ bucket, key, now });
    return this.hits.filter(h => h.bucket === bucket && h.key === key && h.now > now - windowMs).length;
  }
}
