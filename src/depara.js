import { OllyxError, publicError } from './errors.js';
import { singleFlight } from './cache.js';
import { FileStore } from './store.js';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const TRANSIENT = new Set(['reconnect_required', 'not_configured', 'scope_denied', 'network_error', 'rate_limited', 'response_interrupted']);
const FORMATOS = { S: 'simples', E: 'kit', V: 'variacao_pai' };

/** Linha enxuta de um produto da listagem do Bling (sem descrição/imagem). */
export function slimProduct(p) {
  return {
    id: p.id, idPai: p.idProdutoPai || null, codigo: String(p.codigo ?? '').trim(), nome: p.nome,
    formato: p.formato, preco: Number(p.preco) || 0, custo: Number(p.precoCusto) || 0,
    saldo: Number(p.estoque?.saldoVirtualTotal) || 0, situacao: p.situacao,
  };
}

/**
 * Monta as linhas do de-para: tipo, pai da variação, componentes do kit, custo pela composição e alertas.
 * `estruturas` mapeia id do kit -> [{id, quantidade}] ou {erro}.
 */
export function buildDepara(produtos, estruturas = {}) {
  const byId = new Map(produtos.map(p => [p.id, p]));
  const rows = produtos.map(p => {
    const flags = [];
    const tipo = p.idPai ? 'variacao' : FORMATOS[p.formato] || 'desconhecido';
    const row = {
      sku: p.codigo, idBling: p.id, nome: p.nome, tipo, idPai: p.idPai, skuPai: p.idPai ? byId.get(p.idPai)?.codigo ?? null : null,
      preco: p.preco, custo: p.custo, saldo: p.saldo, ativo: p.situacao === 'A', componentes: [], custoComposicao: null, flags,
    };
    if (!row.ativo) flags.push('inativo');
    if (tipo !== 'variacao_pai' && p.custo <= 0) flags.push('sem_custo');
    if (p.formato === 'E') {
      const est = estruturas[p.id];
      if (!est) flags.push('estrutura_pendente');
      else if (est.erro) flags.push('estrutura_erro');
      else {
        let soma = 0, completo = true;
        for (const c of est) {
          const comp = byId.get(c.id);
          if (!comp) { completo = false; flags.push('componente_desconhecido'); continue; }
          row.componentes.push({ sku: comp.codigo, idBling: comp.id, quantidade: c.quantidade, custoUnitario: comp.custo });
          soma += c.quantidade * comp.custo;
        }
        if (!est.length) flags.push('kit_sem_componentes');
        else if (completo) {
          row.custoComposicao = round(soma);
          if (p.custo > 0 && soma > 0 && Math.abs(p.custo - soma) / soma > 0.05) flags.push('custo_kit_diverge');
          if (p.custo <= 0 && soma > 0) row.custo = round(soma); // custo efetivo pela composição
        }
      }
    }
    return row;
  });
  return { rows, bySku: new Map(rows.filter(r => r.sku).map(r => [r.sku, r])) };
}

export class Depara {
  constructor(client, { dir, store = new FileStore(dir), now = Date.now, ttlMs = 6 * 3600e3 } = {}) {
    this.client = client; this.dir = dir; this.store = store; this.now = now; this.ttlMs = ttlMs; this.flight = singleFlight();
  }
  async load() {
    const state = await this.store.get('bling-catalogo');
    return state && Array.isArray(state.produtos) && state.estruturas && typeof state.estruturas === 'object' && Number.isFinite(state.savedAt) ? state : null;
  }
  save(state) { return this.store.set('bling-catalogo', state); }
  async fetchList() {
    const out = [];
    for (let pagina = 1; pagina <= 200; pagina++) {
      const res = await this.client.query('bling', '/produtos', { pagina, limite: 100 });
      const data = res.data?.data;
      if (!Array.isArray(data)) throw new OllyxError('unknown_pagination', 'Listagem de produtos do Bling sem formato reconhecido.');
      out.push(...data.map(slimProduct));
      if (data.length < 100) return out;
    }
    throw new OllyxError('catalog_too_large', 'Catálogo do Bling maior que 20.000 produtos; use filtros.');
  }
  /** Catálogo Bling em cache (TTL). Estruturas de kits são buscadas aos poucos, dentro do orçamento de tempo. */
  catalogo(opts = {}) {
    return this.flight(JSON.stringify({ ...opts, onProgress: undefined }), () => this.catalogoRun(opts));
  }
  async catalogoRun({ atualizar = false, tempoMaxMs = 50000, onProgress } = {}) {
    const started = this.now();
    let state = atualizar ? null : await this.load();
    let dirty = false, erroConexao = null;
    if (!state || this.now() - state.savedAt > this.ttlMs) {
      state = { savedAt: this.now(), produtos: await this.fetchList(), estruturas: {} }; dirty = true;
    }
    // Erros passageiros (autenticação, limite, rede) nunca viram resultado: ficam pendentes e são tentados de novo.
    const transient = e => e && e.erro && TRANSIENT.has(e.erro);
    const AUTH = new Set(['reconnect_required', 'not_configured', 'scope_denied']);
    const kits = state.produtos.filter(p => p.formato === 'E');
    for (const k of kits) if (transient(state.estruturas[k.id])) { delete state.estruturas[k.id]; dirty = true; } // limpa cache antigo
    let stop = false;
    for (const [i, p] of kits.entries()) {
      if (state.estruturas[p.id] || stop) continue;
      await onProgress?.(i, kits.length, 'Lendo estrutura do kit ' + p.codigo);
      if (this.now() - started > tempoMaxMs) break;
      try {
        const res = await this.client.query('bling', '/produtos/estruturas/' + p.id);
        state.estruturas[p.id] = (res.data?.data?.componentes || []).map(c => ({ id: c.produto?.id, quantidade: Number(c.quantidade) || 0 }));
        dirty = true;
      } catch (error) {
        const code = publicError(error).code || 'erro';
        if (TRANSIENT.has(code)) { if (AUTH.has(code)) { stop = true; erroConexao = code; } continue; } // não grava
        state.estruturas[p.id] = { erro: code }; dirty = true;
      }
    }
    const pendentes = kits.filter(k => !state.estruturas[k.id]).length;
    if (dirty) await this.save(state);
    return { ...buildDepara(state.produtos, state.estruturas), atualizadoEm: new Date(state.savedAt).toISOString(), kitsPendentes: pendentes, erroConexao };
  }
}
