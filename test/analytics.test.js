import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateOrders, mergeRows, classify, dayRange, toCsv, Analytics } from '../src/analytics.js';

const order = (sku, item, qty, price, status = 'paid') => ({ status, order_items: [{ quantity: qty, unit_price: price, item: { id: item, title: 't' + item, seller_sku: sku, category_id: 'C1' } }] });

test('aggregateOrders soma por SKU/anúncio e ignora pedidos não pagos', () => {
  const rows = aggregateOrders([order('A', 'M1', 2, 10), order('A', 'M1', 1, 10), order('B', 'M2', 1, 5), order('A', 'M1', 9, 10, 'cancelled')]);
  const a = rows.find(r => r.sku === 'A');
  assert.deepEqual([a.unidades, a.faturamento, a.pedidos], [3, 30, 2]);
  assert.equal(rows.length, 2);
});

test('classify: A até 80%, B até 95%, C o resto; ordena por métrica', () => {
  const rows = [['s1', 50], ['s2', 30], ['s3', 10], ['s4', 6], ['s5', 4]].map(([sku, faturamento]) => ({ sku, faturamento, unidades: 1 }));
  const out = classify(rows.reverse(), 'faturamento', [80, 95]);
  assert.deepEqual(out.map(r => r.sku), ['s1', 's2', 's3', 's4', 's5']);
  assert.deepEqual(out.map(r => r.classe), ['A', 'A', 'B', 'B', 'C']);
  assert.equal(out.at(-1).acumulado, 100);
  assert.throws(() => classify(rows, 'faturamento', [95, 80]));
});

test('mergeRows agrupa por SKU ou por anúncio', () => {
  const rows = [{ sku: 'A', anuncio: 'M1', unidades: 1, faturamento: 10, pedidos: 1 }, { sku: 'A', anuncio: 'M2', unidades: 2, faturamento: 20, pedidos: 1 }];
  assert.equal(mergeRows(rows, 'sku').length, 1);
  assert.equal(mergeRows(rows, 'anuncio').length, 2);
});

test('dayRange e CSV (ponto e vírgula, decimal vírgula, aspas)', () => {
  assert.deepEqual(dayRange(3, '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
  const csv = toCsv([{ posicao: 1, classe: 'C', sku: 'X', anuncio: 'M1', titulo: 'a;"b"', unidades: 1, faturamento: 1.5, pedidos: 1, participacao: 0.1, acumulado: 100 }]);
  assert.match(csv, /"a;""b"""/);
  assert.match(csv, /;1,5;/);
});

test('curvaAbc pagina por dia, usa cache e retoma após estouro de tempo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ollyx-abc-'));
  let calls = 0;
  const now = () => Date.parse('2026-11-06T15:00:00Z');
  const client = { async query(provider, path, params) {
    calls++;
    if (path === '/users/me') return { data: { id: 7 } };
    const day = params['order.date_created.from'].slice(0, 10);
    const all = day === '2026-11-05' ? [order('TOP', 'M1', 100, 10), order('LOW', 'M2', 1, 1)] : [order('TOP', 'M1', 1, 10)];
    const results = all.slice(params.offset, params.offset + params.limit);
    return { data: { results, paging: { total: all.length, offset: params.offset, limit: params.limit } } };
  } };
  const a = new Analytics(client, { dir, now });
  const first = await a.curvaAbc({ dias: 3 });
  assert.equal(first.complete, true);
  assert.equal(first.resumo.C.itens, 1);
  assert.equal(first.ranking.find(r => r.sku === 'LOW').classe, 'C');
  assert.ok((await readdir(join(dir, 'exports'))).length === 1);
  const before = calls;
  const second = await new Analytics(client, { dir, now }).curvaAbc({ dias: 3 });
  assert.equal(second.diasDoCache, 2); // hoje nunca vai para o cache
  assert.equal(calls - before, 1 + 1); // users/me + dia de hoje
  const partial = await new Analytics(client, { dir: await mkdtemp(join(tmpdir(), 'ollyx-abc-')), now: (() => { let t = 0; return () => (t += 10000); })() }).curvaAbc({ dias: 4, tempoMaxMs: 15000 });
  assert.equal(partial.complete, false);
  assert.ok(partial.diasPendentes.length > 0);
});
