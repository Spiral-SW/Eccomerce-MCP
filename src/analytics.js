import { OllyxError } from './errors.js';
import { singleFlight } from './cache.js';
import { FileStore } from './store.js';

const TZ = '-03:00';
const PAGE = 50;
const DAY_CONCURRENCY = 3;
// Cláusulas 2.2.1.3 e 5.3 dos Termos do Programa de Desenvolvedores: cópias intermediárias do Conteúdo do Mercado Livre
// só pelo tempo necessário e atualizadas ao menos a cada 24 h. Cache de pedidos: vale 24 h, e o banco apaga a cópia em 25 h.
export const CACHE_MAX_AGE_MS = 24 * 3600e3;
export const CACHE_TTL_MS = 25 * 3600e3;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Dias (YYYY-MM-DD) em horário de Brasília, do mais antigo ao mais recente, terminando em `endDay`. */
export function dayRange(days, endDay) {
  const out = [];
  const end = new Date(endDay + 'T12:00:00Z');
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end.getTime() - i * 864e5).toISOString().slice(0, 10));
  return out;
}
export function brasiliaToday(now = Date.now()) {
  return new Date(now - 3 * 3600e3).toISOString().slice(0, 10);
}

/** Reduz os pedidos de um dia a linhas por SKU/anúncio (pequeno o bastante para cachear). */
export function aggregateOrders(orders) {
  const map = new Map();
  for (const order of orders) {
    if (order.status !== 'paid') continue;
    for (const line of order.order_items || []) {
      const item = line.item || {};
      const sku = line.seller_sku || item.seller_sku || item.seller_custom_field || '(sem SKU)';
      const key = sku + '|' + item.id;
      const row = map.get(key) || { sku, anuncio: item.id, titulo: item.title, categoria: item.category_id, unidades: 0, faturamento: 0, tarifa: 0, pedidos: 0 };
      row.unidades += Number(line.quantity) || 0;
      row.tarifa += (Number(line.sale_fee) || 0) * (Number(line.quantity) || 0);
      row.faturamento += (Number(line.unit_price) || 0) * (Number(line.quantity) || 0);
      row.pedidos += 1;
      map.set(key, row);
    }
  }
  return [...map.values()].map(r => ({ ...r, faturamento: round(r.faturamento), tarifa: round(r.tarifa) }));
}

/** Soma linhas diárias e agrupa por SKU ou por anúncio. */
export function mergeRows(rows, agrupar = 'sku') {
  const map = new Map();
  for (const r of rows) {
    const key = agrupar === 'anuncio' ? r.anuncio : r.sku;
    const cur = map.get(key) || { sku: r.sku, anuncios: new Set(), anuncio: r.anuncio, titulo: r.titulo, categoria: r.categoria, unidades: 0, faturamento: 0, tarifa: 0, custo: 0, semCusto: false, pedidos: 0 };
    cur.unidades += r.unidades; cur.faturamento += r.faturamento; cur.pedidos += r.pedidos;
    cur.tarifa += r.tarifa || 0; cur.custo += r.custo || 0; cur.semCusto ||= !!r.semCusto;
    cur.anuncios.add(r.anuncio);
    map.set(key, cur);
  }
  return [...map.values()].map(r => {
    const faturamento = round(r.faturamento), tarifa = round(r.tarifa), custo = round(r.custo), margem = round(faturamento - tarifa - custo);
    return { ...r, anuncios: [...r.anuncios], faturamento, tarifa, custo, margem, margemPct: faturamento ? round((margem / faturamento) * 100) : 0 };
  });
}

/** Classifica A/B/C: o item entra na classe enquanto o acumulado ANTES dele ainda não passou do corte. */
export function classify(rows, metrica = 'faturamento', cortes = [80, 95]) {
  const [a, b] = cortes;
  if (!(a > 0 && a < b && b < 100)) throw new OllyxError('invalid_cuts', 'Cortes devem ser crescentes, entre 0 e 100 (ex.: 80 e 95).');
  const sorted = [...rows].sort((x, y) => y[metrica] - x[metrica] || String(x.sku).localeCompare(String(y.sku)));
  const val = r => Math.max(0, r[metrica]); // margem negativa não cria participação: cai na classe C
  const total = sorted.reduce((s, r) => s + val(r), 0);
  let acc = 0;
  return sorted.map((r, i) => {
    const before = total ? (acc / total) * 100 : 100;
    acc += val(r);
    return { posicao: i + 1, ...r, participacao: round(total ? (val(r) / total) * 100 : 0, 3), acumulado: round(total ? (acc / total) * 100 : 100, 2), classe: before < a ? 'A' : before < b ? 'B' : 'C' };
  });
}

export function toCsv(rows) {
  const cols = ['posicao', 'classe', 'sku', 'anuncio', 'titulo', 'unidades', 'faturamento', 'tarifa', 'custo', 'margem', 'margemPct', 'semCusto', 'pedidos', 'participacao', 'acumulado'];
  const cell = v => {
    if (typeof v === 'boolean') return v ? 'sim' : '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    const s = String(v ?? '');
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [cols.join(';'), ...rows.map(r => cols.map(c => cell(r[c])).join(';'))].join('\r\n') + '\r\n';
}

/** Custo e margem por linha (SKU+anúncio) a partir do catálogo Bling. margem = faturamento - tarifa ML - custo. */
export function enrich(rows, bySku) {
  return rows.map(r => {
    const unit = bySku?.get(r.sku)?.custo || 0;
    return { ...r, custo: round(unit * r.unidades), semCusto: !unit };
  });
}
/** Abre kits em componentes; faturamento e tarifa são rateados pelo custo (ou pela quantidade, sem custo). */
export function explodeKits(rows, bySku) {
  const out = [];
  for (const r of rows) {
    const comps = bySku?.get(r.sku)?.componentes || [];
    if (!comps.length) { out.push(r); continue; }
    const weight = c => c.quantidade * (c.custoUnitario || 0);
    let total = comps.reduce((s, c) => s + weight(c), 0);
    const w = total > 0 ? weight : c => c.quantidade;
    total = comps.reduce((s, c) => s + w(c), 0);
    for (const c of comps) {
      const share = w(c) / total;
      out.push({ ...r, sku: c.sku, unidades: r.unidades * c.quantidade, faturamento: round(r.faturamento * share), tarifa: round((r.tarifa || 0) * share), origemKit: r.sku });
    }
  }
  return out;
}

export class Analytics {
  constructor(client, { dir, store = new FileStore(dir), now = Date.now, depara = null } = {}) {
    this.client = client; this.dir = dir; this.store = store; this.now = now; this.depara = depara; this.sellerId = null;
    this.flight = singleFlight();
  }
  async seller() {
    if (!this.sellerId) {
      const me = await this.client.query('meli', '/users/me');
      this.sellerId = me.data?.id;
      if (!this.sellerId) throw new OllyxError('seller_unknown', 'Não foi possível identificar o vendedor da conta do ML.');
    }
    return this.sellerId;
  }
  cacheKey(day) { return 'orders2-' + this.sellerId + '-' + day; }
  async readDay(day) {
    const cached = await this.store.get(this.cacheKey(day));
    return cached && Array.isArray(cached.rows) && Number.isInteger(cached.totalPedidos) ? cached : null; // ignora cache inválido
  }
  async fetchDay(day) {
    const orders = [];
    let offset = 0, total = Infinity;
    while (offset < total) {
      const res = await this.client.query('meli', '/orders/search', {
        seller: this.sellerId, 'order.status': 'paid',
        'order.date_created.from': day + 'T00:00:00.000' + TZ, 'order.date_created.to': day + 'T23:59:59.999' + TZ,
        sort: 'date_asc', limit: PAGE, offset,
      });
      const results = res.data?.results, paging = res.data?.paging;
      if (!Array.isArray(results) || !Number.isInteger(paging?.total)) throw new OllyxError('unknown_pagination', 'Resposta de pedidos sem paginação reconhecível.');
      if (paging.total > 9000) throw new OllyxError('day_too_large', 'Dia com pedidos demais para uma janela única: ' + day);
      total = paging.total; orders.push(...results); offset += PAGE;
      if (!results.length) break;
    }
    return { day, totalPedidos: total, rows: aggregateOrders(orders), savedAt: this.now() };
  }
  /**
   * Curva ABC a partir de pedidos pagos do Mercado Livre. Dias fechados ficam em cache (dir/cache),
   * então uma execução interrompida pelo orçamento de tempo continua de onde parou na chamada seguinte.
   */
  curvaAbc(opts = {}) {
    const key = JSON.stringify({ ...opts, onProgress: undefined });
    return this.flight(key, () => this.curvaAbcRun(opts));
  }
  async curvaAbcRun({ dias = 30, metrica = 'faturamento', agrupar = 'sku', cortes = [80, 95], tempoMaxMs = 45000, exportar = true, custos = true, renovar = false, onProgress } = {}) {
    await this.seller();
    const started = this.now();
    const today = brasiliaToday(this.now());
    const days = dayRange(dias, today);
    const rows = [];
    let done = 0, fromCache = 0, pedidos = 0;
    const pending = [];
    // Dias fechados vêm do cache em UMA consulta (antes era uma por dia). O dia de hoje nunca é cacheado.
    // `renovar` (tarefa diária) ignora o cache e relê tudo; sem ele, cópias com mais de 24 h ou sem data de gravação são descartadas.
    const cachedByKey = renovar ? new Map() : await this.store.getMany(days.filter(d => d !== today).map(d => this.cacheKey(d)));
    const valid = c => (c && Array.isArray(c.rows) && Number.isInteger(c.totalPedidos) && Number.isFinite(c.savedAt) && this.now() - c.savedAt <= CACHE_MAX_AGE_MS ? c : null);
    let oldest = Infinity;
    const missing = [];
    for (const day of days) {
      const cached = day === today ? null : valid(cachedByKey.get(this.cacheKey(day)));
      if (cached) { rows.push(...cached.rows); pedidos += cached.totalPedidos; done++; fromCache++; oldest = Math.min(oldest, cached.savedAt); } else missing.push(day);
    }
    // Dias que faltam, 3 por vez. O ApiClient já espaça as chamadas (250 ms no Mercado Livre), então o ritmo
    // continua seguro; o ganho vem de sobrepor a latência de rede das respostas.
    for (let i = 0; i < missing.length; i += DAY_CONCURRENCY) {
      const chunk = missing.slice(i, i + DAY_CONCURRENCY);
      if (this.now() - started > tempoMaxMs) { pending.push(...chunk); continue; }
      await onProgress?.(done, days.length, 'Lendo pedidos de ' + chunk[0] + (chunk.length > 1 ? ' a ' + chunk[chunk.length - 1] : ''));
      const fetched = await Promise.all(chunk.map(async day => {
        const fresh = await this.fetchDay(day);
        if (day !== today) await this.store.set(this.cacheKey(day), fresh, { ttlMs: CACHE_TTL_MS });
        return fresh;
      }));
      for (const fresh of fetched) { rows.push(...fresh.rows); pedidos += fresh.totalPedidos; done++; oldest = Math.min(oldest, fresh.savedAt); }
    }
    let catalogo = null, aviso = null, kitsPendentes = 0;
    if ((custos || agrupar === 'base' || metrica === 'margem') && this.depara) {
      try {
        catalogo = await this.depara.catalogo({ tempoMaxMs: Math.max(5000, tempoMaxMs - (this.now() - started)) });
        kitsPendentes = catalogo.kitsPendentes;
      } catch (error) { aviso = 'Catálogo Bling indisponível (' + (error.code || 'erro') + '): custo e margem não calculados.'; }
    }
    if (metrica === 'margem' && !catalogo) throw new OllyxError('cost_unavailable', aviso || 'Métrica margem exige o catálogo Bling (custos).');
    let base = rows;
    if (agrupar === 'base') base = explodeKits(base, catalogo?.bySku);
    if (catalogo) base = enrich(base, catalogo.bySku);
    const ranked = classify(mergeRows(base, agrupar === 'anuncio' ? 'anuncio' : 'sku'), metrica, cortes);
    const resumo = {};
    for (const c of ['A', 'B', 'C']) {
      const g = ranked.filter(r => r.classe === c);
      resumo[c] = { itens: g.length, unidades: g.reduce((s, r) => s + r.unidades, 0), faturamento: round(g.reduce((s, r) => s + r.faturamento, 0)), margem: catalogo ? round(g.reduce((s, r) => s + r.margem, 0)) : null, itensSemCusto: catalogo ? g.filter(r => r.semCusto).length : null };
    }
    let arquivo = null, download = null;
    if (exportar && ranked.length) {
      const saved = await this.store.putExport(`curva-abc-${today}-${dias}d-${agrupar}-${metrica}.csv`, toCsv(ranked));
      arquivo = saved.arquivo ?? null; download = saved.download ?? null;
    }
    return {
      complete: pending.length === 0, periodo: { dias, de: days[0], ate: days[days.length - 1] },
      diasProcessados: done, diasDoCache: fromCache, diasPendentes: pending,
      pedidosPagos: pedidos, metrica, agrupar, cortes, resumo, arquivo, download, aviso,
      frequenciaAtualizacao: '24 h', dadosAtualizadosEm: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null, kitsPendentes, custosDoBling: !!catalogo,
      note: pending.length ? 'Tempo esgotado: chame novamente com os mesmos parâmetros; os dias já lidos estão em cache. A curva abaixo é PARCIAL.' : 'Curva completa para o período. Itens sem venda no período não aparecem.',
      ranking: ranked,
    };
  }
}
