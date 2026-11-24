import test from 'node:test';
import assert from 'node:assert/strict';
import { redactPersonal, protectResult, MASK } from '../src/privacy.js';

// Formato real de um pedido do Mercado Livre (campos pessoais e de cartão incluídos).
const pedidoMl = {
  results: [{
    id: 2000018841617218, status: 'paid', total_amount: 91, date_created: '2026-10-06T23:15:47.000-04:00',
    buyer: { id: 55483422, nickname: 'VOARVARIEDADES' }, seller: { id: 221999317, nickname: 'OLLYX' },
    shipping: { id: 48193043757, receiver_address: { street_name: 'Rua X', zip_code: '30310300', city: { name: 'BH' } } },
    payments: [{ id: 1, payer_id: 55483422, card_id: 9059070076, authorization_code: '7T1WT4', payment_method_id: 'visa', transaction_amount: 81.65, status: 'approved' }],
    order_items: [{ quantity: 1, unit_price: 91, item: { id: 'MLB5335996844', title: 'Luva Inverno', seller_sku: 'LUVAINV3MG' } }],
  }],
  paging: { total: 1, offset: 0, limit: 1 },
};

test('pedido do ML: oculta comprador, endereço e cartão; mantém o que serve à análise', () => {
  const { value, ocultados } = redactPersonal(pedidoMl);
  const o = value.results[0];
  assert.equal(o.buyer, MASK);
  assert.equal(o.seller.nickname, MASK);
  assert.equal(o.seller.id, 221999317); // id da própria conta não é pessoal de terceiro
  assert.equal(o.shipping.receiver_address, MASK);
  assert.equal(o.payments[0].payer_id, MASK);
  assert.equal(o.payments[0].card_id, MASK);
  assert.equal(o.payments[0].authorization_code, MASK);
  assert.deepEqual([o.id, o.status, o.total_amount], [2000018841617218, 'paid', 91]);
  assert.deepEqual(o.order_items[0].item, { id: 'MLB5335996844', title: 'Luva Inverno', seller_sku: 'LUVAINV3MG' });
  assert.equal(o.payments[0].transaction_amount, 81.65);
  assert.deepEqual(value.paging, pedidoMl.paging);
  assert.equal(ocultados, 6); // buyer, seller.nickname, receiver_address, payer_id, card_id, authorization_code
  const texto = JSON.stringify(value);
  for (const segredo of ['VOARVARIEDADES', 'Rua X', '30310300', '9059070076', '7T1WT4', 'OLLYX']) assert.equal(texto.includes(segredo), false, segredo);
});

test('perfil do usuário (/users/me) e mensagens: tudo pessoal fica oculto, texto de conversa só dentro de mensagens', () => {
  const me = { id: 1, nickname: 'OLLYX', first_name: 'A', last_name: 'B', email: 'a@b.com', phone: { number: '999' }, identification: { type: 'CNPJ', number: '41993787000117' }, address: { city: 'BH' }, site_id: 'MLB', seller_reputation: { level_id: '5_green' } };
  const out = redactPersonal(me).value;
  assert.deepEqual([out.nickname, out.first_name, out.email, out.phone, out.identification, out.address], Array(6).fill(MASK));
  assert.deepEqual([out.id, out.site_id, out.seller_reputation.level_id], [1, 'MLB', '5_green']);
  const msgs = redactPersonal({ messages: [{ id: 'm1', text: 'meu endereço é...', from: { user_id: 9 } }], title: { text: 'não é conversa' } }).value;
  assert.equal(msgs.messages[0].text, MASK);
  assert.equal(msgs.messages[0].id, 'm1');
  assert.equal(msgs.title.text, 'não é conversa');
});

test('Bling: contato, documento, endereço e telefone ocultos; produto e nome do produto preservados', () => {
  const pedido = { data: [{ id: 1, numero: 10, total: 55, contato: { id: 7, nome: 'Fulana', numeroDocumento: '123' }, transporte: { enderecoEntrega: { endereco: 'Rua', cep: '1' } }, itens: [{ codigo: 'SKU1', descricao: 'Produto', quantidade: 2 }] }] };
  const out = redactPersonal(pedido).value.data[0];
  assert.equal(out.contato, MASK);
  assert.equal(out.transporte.enderecoEntrega, MASK);
  assert.deepEqual(out.itens, pedido.data[0].itens);
  const prod = redactPersonal({ data: [{ id: 5, nome: 'Anel Prateado', codigo: 'A1', preco: 9 }] }).value;
  assert.equal(prod.data[0].nome, 'Anel Prateado');
});

test('valores vazios não contam; a entrada não é alterada; protectResult anota a regra', () => {
  const entrada = { buyer: null, email: '', nickname: 'X' };
  const copia = JSON.parse(JSON.stringify(entrada));
  const { value, ocultados } = redactPersonal(entrada);
  assert.deepEqual(entrada, copia);
  assert.equal(ocultados, 1);
  assert.equal(value.buyer, null);
  const prot = protectResult(pedidoMl);
  assert.equal(prot.privacidade.camposPessoaisOcultados, 6);
  assert.match(prot.privacidade.regra, /não saem do servidor/);
});
