import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createApiLogger } from './api-logger.js';
import { OllyxError, publicError } from './errors.js';
import { validateQuery, catalogs } from './catalog.js';
import { readLimited, redact } from './io.js';
export const bases = Object.freeze({ bling: 'https://api.bling.com.br/Api/v3', meli: 'https://api.mercadolibre.com' });

export function safeHeaders(input = {}) {
  const allowed = {
    'api-version': ['1', '2'], 'x-new-domain': ['true'], 'x-format-new': ['true'],
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OllyxError('invalid_headers', 'Cabeçalhos de versão inválidos.');
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(allowed, key) || !allowed[key].includes(value)) throw new OllyxError('invalid_headers', 'Somente cabeçalhos de versão documentados são aceitos.');
  }
  return { ...input };
}
export class ApiClient {
  constructor(config, tokens, { fetchImpl = fetch, sleep = delay, now = Date.now, logger = createApiLogger({ enabled: config.apiLogging !== false }) } = {}) {
    this.config = config; this.tokens = tokens; this.fetch = fetchImpl; this.sleep = sleep; this.now = now;
    this.logger = logger;
    this.queues = { bling: Promise.resolve(), meli: Promise.resolve() };
    this.next = { bling: 0, meli: 0 };
    this.stats = { calls: 0, ms: 0 }; // chamadas externas feitas e tempo total (inclui espera de ritmo); usado no registro por ferramenta
  }
  async dispatch(provider, perform) {
    const next = this.queues[provider].then(async () => {
      const remaining = this.next[provider] - this.now();
      if (remaining > 0) await this.sleep(remaining);
      this.next[provider] = this.now() + (provider === 'bling' ? 400 : 250);
      return perform();
    });
    this.queues[provider] = next.catch(() => {});
    return next;
  }
  async query(provider, path, params = {}, headers = {}) {
    const context = { requestId: randomUUID(), provider, path };
    const started = this.now();
    try { return await this.queryValidated(provider, path, params, headers, context); }
    catch (error) {
      this.logger.record({ ...context, event: 'api_error', status: error.extra?.status, error: publicError(error).code, durationMs: this.now() - started });
      throw error;
    }
  }
  async queryValidated(provider, path, params, headers, context) {
    const query = validateQuery(provider, path, params);
    const versionHeaders = safeHeaders(headers);
    const url = bases[provider] + path + (query.size ? '?' + query.toString() : '');
    let token = await this.tokens.get(provider);
    let renewed = false, rateRetries = 0, attempt = 0;
    for (;;) {
      let response;
      const attemptStart = this.now();
      let requestError;
      attempt++;
      try {
        response = await this.dispatch(provider, () => this.fetch(url, {
          method: 'GET', headers: { ...versionHeaders, Authorization: 'Bearer ' + token, Accept: 'application/json' },
          redirect: 'manual', signal: AbortSignal.timeout(this.config.timeoutMs),
        }));
      } catch {
        requestError = 'network_error';
        throw new OllyxError('network_error', 'A consulta não recebeu resposta. Verifique a conexão ou tente novamente.');
      } finally {
        const durationMs = this.now() - attemptStart;
        this.stats.calls++; this.stats.ms += durationMs;
        this.logger.record({ ...context, event: 'api_request', attempt, status: response?.status, durationMs, error: requestError });
      }
      if (response.status === 401 && !renewed) {
        await response.body?.cancel();
        token = await this.tokens.get(provider, token); renewed = true; continue;
      }
      if ((response.status === 429 || response.status >= 500) && rateRetries < 2) {
        const header = response.headers.get('retry-after');
        let retryMs = header == null ? 0 : Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - this.now();
        if (!Number.isFinite(retryMs)) retryMs = 0;
        await response.body?.cancel();
        if (retryMs > 10000) throw new OllyxError('rate_limited', 'A API pediu uma espera maior. Tente novamente mais tarde.', { status: response.status, retryAfterMs: retryMs });
        await this.sleep(Math.max(500 * 2 ** rateRetries, retryMs));
        rateRetries++; continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const code = response.status === 403 ? 'scope_denied' : response.status >= 300 && response.status < 400 ? 'redirect_blocked' : 'upstream_error';
        throw new OllyxError(code, response.status === 403
          ? 'A API negou a consulta. Confira os escopos, a conta e a disponibilidade do recurso.'
          : 'A API recusou a consulta. Confira o recurso e seus filtros.', { status: response.status });
      }
      let bytes;
      try { bytes = await readLimited(response, this.config.maxResponseBytes); }
      catch (error) {
        if (error instanceof OllyxError) throw error;
        throw new OllyxError('response_interrupted', 'A resposta foi interrompida. Tente novamente.');
      }
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      let data;
      if (contentType.includes('json')) {
        try { data = JSON.parse(bytes.toString('utf8')); }
        catch { throw new OllyxError('invalid_response', 'A API devolveu JSON inválido.'); }
      } else if (/^(text\/)|xml/.test(contentType)) data = bytes.toString('utf8');
      else data = { encoding: 'base64', content: bytes.toString('base64') };
      return {
        provider, path, status: response.status, checkedAt: new Date(this.now()).toISOString(),
        pageOnly: true, contentType, data: redact(data, [token, this.config.providers[provider].clientSecret]),
        note: 'Uma resposta da API. Uma página não representa todos os registros.',
      };
    }
  }
  async pages(provider, path, params = {}, maxPages = 5, headers = {}) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new OllyxError('invalid_page_count', 'maxPages deve ficar entre 1 e 20.');
    validateQuery(provider, path, params); safeHeaders(headers);
    const pages = [], initial = { ...params };
    const numberParam = (key, fallback, min, max) => {
      const v = Number(initial[key] ?? fallback);
      if (!Number.isInteger(v) || v < min || v > max) throw new OllyxError('invalid_pagination', 'Parâmetro de paginação inválido: ' + key);
      return v;
    };
    let position = numberParam(provider === 'bling' ? 'pagina' : 'offset', provider === 'bling' ? 1 : 0, provider === 'bling' ? 1 : 0, Number.MAX_SAFE_INTEGER);
    const limit = numberParam(provider === 'bling' ? 'limite' : 'limit', 50, 1, 100);
    const key = provider === 'bling' ? 'pagina' : 'offset';
    const limitKey = provider === 'bling' ? 'limite' : 'limit';
    if (provider === 'meli' && (initial.search_type === 'scan' || initial.scroll_id)) {
      throw new OllyxError('cursor_pagination', 'Para paginação por cursor, use ollyx_consultar e o scroll_id retornado pela API.');
    }
    if (provider === 'bling') {
      const possible = catalogs.bling.resources.filter(r => r.parameters.some(p => p.name === 'pagina') && r.parameters.some(p => p.name === 'limite'));
      const matches = possible.some(r => {
        const template = r.path.split('/'), actual = path.split('/');
        return template.length === actual.length && template.every((s, i) => /^\{\w+\}$/.test(s) || s === actual[i]);
      });
      if (!matches) throw new OllyxError('unknown_pagination', 'O OpenAPI deste recurso não documenta pagina/limite. Consulte uma página por vez.');
    }
    let bytes = 0, previousItems;
    for (let i = 0; i < maxPages; i++) {
      const current = { ...initial, [key]: position, [limitKey]: limit };
      let result;
      try { result = await this.query(provider, path, current, headers); }
      catch (error) {
        if (!pages.length) throw error;
        return { provider, path, pages, complete: false, reason: 'upstream_error', error: publicError(error), nextParams: current };
      }
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > this.config.maxResponseBytes) return { provider, path, pages, complete: false, reason: 'output_limit', nextParams: current };
      pages.push(result);
      const items = provider === 'bling' ? result.data?.data : result.data?.results;
      let effectiveLimit = limit, total = null;
      if (!Array.isArray(items)) return { provider, path, pages, complete: false, reason: 'unknown_pagination', nextParams: null };
      if (provider === 'meli') {
        const paging = result.data?.paging;
        if (!Number.isInteger(paging?.limit) || paging.limit < 1 || paging.limit > limit || paging.offset !== position
          || !Number.isInteger(paging.total) || paging.total < 0) {
          return { provider, path, pages, complete: false, reason: 'unknown_pagination', nextParams: null, note: 'Sem metadados offset/limit/total compatíveis. Consulte manualmente.' };
        }
        effectiveLimit = paging.limit; total = paging.total;
      }
      const fingerprint = JSON.stringify(items);
      if (items.length && fingerprint === previousItems) return { provider, path, pages, complete: false, reason: 'repeated_page', nextParams: current };
      previousItems = fingerprint;
      const short = items.length < effectiveLimit;
      const reachedTotal = total !== null && position + items.length >= total;
      if (provider === 'meli' && short && !reachedTotal) return { provider, path, pages, complete: false, reason: 'inconsistent_pagination', nextParams: current };
      if (items.length === 0 || short || reachedTotal) return {
        provider, path, pages, complete: true, reason: 'end_of_page_sequence', nextParams: null,
        note: 'Fim da sequência a partir da página inicial informada; não é um snapshot transacional.',
      };
      position += provider === 'bling' ? 1 : effectiveLimit;
    }
    return { provider, path, pages, complete: false, reason: 'max_pages', nextParams: { ...initial, [key]: position, [limitKey]: limit } };
  }
}
