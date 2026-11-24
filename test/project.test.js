import test from 'node:test';
import assert from 'node:assert/strict';
import { projectData, projectResult } from '../src/project.js';

const blingProduto = { id: 1, codigo: 'A', nome: 'n', descricaoCurta: '<p>' + 'x'.repeat(5000) + '</p>', imagemURL: 'http://x', estoque: { saldoVirtualTotal: 7, minimo: 0 }, preco: 10 };

test('Bling {data:[...]}: devolve só os campos pedidos, inclusive aninhados, e corta o resto', () => {
  const out = projectData({ data: [blingProduto, { ...blingProduto, id: 2 }] }, ['id', 'codigo', 'estoque.saldoVirtualTotal']);
  assert.deepEqual(out, { data: [{ id: 1, codigo: 'A', estoque: { saldoVirtualTotal: 7 } }, { id: 2, codigo: 'A', estoque: { saldoVirtualTotal: 7 } }] });
  assert.ok(JSON.stringify(out).length < 200);
});

test('Bling {data:{...}} (um item) e Meli {results, paging} preservam metadados', () => {
  assert.deepEqual(projectData({ data: blingProduto }, ['nome']), { data: { nome: 'n' } });
  const meli = { results: [{ id: 'M1', status: 'paid', order_items: [{ quantity: 2, item: { id: 'I1', title: 't', seller_sku: 'S1' } }, { quantity: 1, item: { id: 'I2', title: 'u', seller_sku: 'S2' } }] }], paging: { total: 1, offset: 0, limit: 50 } };
  const out = projectData(meli, ['id', 'order_items.quantity', 'order_items.item.seller_sku']);
  assert.deepEqual(out.paging, meli.paging);
  assert.deepEqual(out.results[0], { id: 'M1', order_items: [{ quantity: 2, item: { seller_sku: 'S1' } }, { quantity: 1, item: { seller_sku: 'S2' } }] });
});

test('caminhos inexistentes são ignorados; sem campos nada muda; caminho inválido é recusado', () => {
  assert.deepEqual(projectData({ data: [blingProduto] }, ['id', 'nao.existe']), { data: [{ id: 1 }] });
  const same = { data: [blingProduto] };
  assert.equal(projectData(same, undefined), same);
  assert.equal(projectData(same, []), same);
  assert.throws(() => projectData(same, ['id; DROP']), /Campo inválido/);
  assert.throws(() => projectData(same, ['a..b']), /Campo inválido/);
});

test('projectResult: consulta simples e várias páginas, anotando os campos aplicados', () => {
  const single = projectResult({ status: 200, data: { data: [blingProduto] } }, ['id']);
  assert.deepEqual(single.data, { data: [{ id: 1 }] });
  assert.deepEqual(single.camposAplicados, ['id']);
  const pages = projectResult({ complete: true, pages: [{ status: 200, data: { data: [blingProduto] } }, { status: 200, data: { data: [{ ...blingProduto, id: 9 }] } }] }, ['id']);
  assert.deepEqual(pages.pages.map(p => p.data.data[0].id), [1, 9]);
  assert.equal(pages.complete, true);
});
