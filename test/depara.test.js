import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slimProduct, buildDepara, Depara } from '../src/depara.js';
import { enrich, explodeKits, mergeRows, classify } from '../src/analytics.js';

const prod = (id, codigo, formato, precoCusto, extra = {}) => ({ id, codigo, nome: 'n' + codigo, formato, preco: 10, precoCusto, situacao: 'A', estoque: { saldoVirtualTotal: 5 }, descricaoCurta: '<p>x</p>', ...extra });
const lista = [prod(1, 'UN', 'S', 1.25), prod(2, 'KIT3', 'E', 3.75), prod(3, 'PAI', 'V', 0), prod(4, 'PAI-G', 'S', 2, { idProdutoPai: 3 }), prod(5, 'ZERO', 'S', 0, { situacao: 'I' }), prod(6, 'KITX', 'E', 9)];

test('slimProduct descarta descrição/imagem e normaliza números', () => {
  const s = slimProduct(lista[0]);
  assert.equal(s.descricaoCurta, undefined);
  assert.deepEqual([s.codigo, s.custo, s.saldo], ['UN', 1.25, 5]);
});

test('buildDepara: tipos, pai da variação, componentes do kit, custo pela composição e alertas', () => {
  const { rows, bySku } = buildDepara(lista.map(slimProduct), { 2: [{ id: 1, quantidade: 3 }], 6: [{ id: 1, quantidade: 2 }] });
  assert.equal(bySku.get('PAI-G').tipo, 'variacao');
  assert.equal(bySku.get('PAI-G').skuPai, 'PAI');
  assert.equal(bySku.get('PAI').flags.includes('sem_custo'), false); // pai de variação não tem custo próprio
  assert.deepEqual(bySku.get('KIT3').componentes.map(c => [c.sku, c.quantidade]), [['UN', 3]]);
  assert.equal(bySku.get('KIT3').custoComposicao, 3.75);
  assert.deepEqual(bySku.get('KIT3').flags, []);
  assert.ok(bySku.get('KITX').flags.includes('custo_kit_diverge')); // 9 vs 2 x 1,25
  assert.ok(bySku.get('ZERO').flags.includes('sem_custo') && bySku.get('ZERO').flags.includes('inativo'));
  assert.equal(rows.length, 6);
  assert.ok(buildDepara(lista.map(slimProduct), {}).bySku.get('KIT3').flags.includes('estrutura_pendente'));
});

test('variação de kit (formato E com pai) também tem a estrutura resolvida', () => {
  const l = [prod(1, 'UN', 'S', 1), prod(7, 'KITPAI', 'V', 0), prod(8, 'KITPAI-A', 'E', 2, { idProdutoPai: 7 })].map(slimProduct);
  const { bySku } = buildDepara(l, { 8: [{ id: 1, quantidade: 2 }] });
  assert.equal(bySku.get('KITPAI-A').tipo, 'variacao');
  assert.deepEqual(bySku.get('KITPAI-A').componentes.map(c => [c.sku, c.quantidade]), [['UN', 2]]);
  assert.ok(buildDepara(l, {}).bySku.get('KITPAI-A').flags.includes('estrutura_pendente'));
});

test('enrich calcula custo; explodeKits rateia faturamento/tarifa pelo custo e multiplica unidades', () => {
  const { bySku } = buildDepara(lista.map(slimProduct), { 2: [{ id: 1, quantidade: 3 }] });
  const venda = [{ sku: 'KIT3', anuncio: 'M1', unidades: 2, faturamento: 100, tarifa: 10, pedidos: 2 }];
  const base = explodeKits(venda, bySku);
  assert.deepEqual([base[0].sku, base[0].unidades, base[0].faturamento, base[0].tarifa], ['UN', 6, 100, 10]);
  const [m] = mergeRows(enrich(base, bySku), 'sku');
  assert.deepEqual([m.custo, m.margem], [7.5, 82.5]); // 6 x 1,25
  assert.equal(m.margemPct, 82.5);
  assert.equal(enrich([{ sku: 'ZERO', unidades: 1, faturamento: 5, tarifa: 0 }], bySku)[0].semCusto, true);
});

test('classify por margem: negativa cai em C sem distorcer o acumulado', () => {
  const out = classify([{ sku: 'a', margem: 90 }, { sku: 'b', margem: 10 }, { sku: 'c', margem: -50 }], 'margem', [80, 95]);
  assert.deepEqual(out.map(r => r.classe), ['A', 'B', 'C']);
  assert.equal(out[2].participacao, 0);
});

test('Depara.catalogo: usa cache (TTL), retoma estruturas pendentes e não busca de novo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ollyx-dp-'));
  let t = 1000, calls = [];
  const client = { async query(_, path, params) {
    calls.push(path);
    if (path === '/produtos') return { data: { data: params.pagina === 1 ? lista : [] } };
    return { data: { data: { componentes: [{ produto: { id: 1 }, quantidade: 3 }] } } };
  } };
  const now = () => (t += 10);
  const d = new Depara(client, { dir, now });
  const a = await d.catalogo({ tempoMaxMs: 0 }); // sem orçamento: lista sim, kits pendentes
  assert.equal(a.kitsPendentes, 2);
  const b = await new Depara(client, { dir, now }).catalogo({ tempoMaxMs: 10000 });
  assert.equal(b.kitsPendentes, 0);
  assert.equal(calls.filter(c => c === '/produtos').length, 1); // lista veio do cache
  const n = calls.length;
  await new Depara(client, { dir, now }).catalogo();
  assert.equal(calls.length, n); // tudo em cache
});

test('erro de autenticação/rede não é gravado como definitivo e interrompe as buscas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ollyx-dp-'));
  const { OllyxError } = await import('../src/errors.js');
  let estrutura = 0, modo = 'auth';
  const client = { async query(_, path, params) {
    if (path === '/produtos') return { data: { data: params.pagina === 1 ? lista : [] } };
    estrutura++;
    if (modo === 'auth') throw new OllyxError('reconnect_required', 'x');
    if (modo === 'definitivo') throw new OllyxError('upstream_error', 'x', { status: 404 });
    return { data: { data: { componentes: [{ produto: { id: 1 }, quantidade: 1 }] } } };
  } };
  const mk = () => new Depara(client, { dir, now: Date.now });
  const a = await mk().catalogo();
  assert.equal(estrutura, 1); // parou na primeira falha de autenticação
  assert.deepEqual([a.kitsPendentes, a.erroConexao], [2, 'reconnect_required']);
  assert.equal(a.bySku.get('KIT3').flags.includes('estrutura_erro'), false);
  modo = 'ok';
  const b = await mk().catalogo(); // reconectado: tenta de novo
  assert.deepEqual([b.kitsPendentes, b.erroConexao], [0, null]);
  assert.equal(b.bySku.get('KIT3').componentes.length, 1);
  const dir2 = await mkdtemp(join(tmpdir(), 'ollyx-dp-')); modo = 'definitivo';
  const c = await new Depara(client, { dir: dir2, now: Date.now }).catalogo();
  assert.equal(c.kitsPendentes, 0); // 404 é resposta definitiva: grava erro e segue
  assert.ok(c.bySku.get('KIT3').flags.includes('estrutura_erro'));
});
