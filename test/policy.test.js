import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuery, catalogs, findResources } from '../src/catalog.js';
import { safeHeaders } from '../src/client.js';

test('100 rotas GET do Bling são consultáveis e não incluem escrita', () => {
  assert.equal(catalogs.bling.resources.length, 100);
  for (const entry of catalogs.bling.resources) {
    assert.equal(entry.method, 'GET');
    validateQuery('bling', entry.path.replace(/\{\w+\}/g, '123'));
  }
  assert.throws(() => validateQuery('bling', '/pedidos/vendas/123/lancar-estoque'), { code: 'unknown_read_endpoint' });
});
test('rejeita URLs externas, escapes, navegação, query embutida e autenticação', () => {
  for (const path of ['https://evil.test/users/me', '//evil.test/x', '/x/../oauth/token', '/x/%2e%2e/y', '/x\\y', '/users/me?method=POST', '/oauth/token', '/auth/authorize', '/users/me#x', '/users//me']) {
    assert.throws(() => validateQuery('meli', path), path);
  }
});
test('não permite método/cabeçalhos/credenciais nos parâmetros', () => {
  for (const key of ['_method', 'method', 'access_token', 'authorization', 'refresh_token', 'client_secret', 'callback']) {
    assert.throws(() => validateQuery('meli', '/users/me', { [key]: 'POST' }));
  }
  for (const headers of [{ Authorization: 'Bearer fake' }, { host: 'evil.test' }, { 'x-http-method-override': 'POST' }, { 'api-version': 'x' }]) {
    assert.throws(() => safeHeaders(headers), { code: 'invalid_headers' });
  }
  assert.deepEqual(safeHeaders({ 'api-version': '2' }), { 'api-version': '2' });
});
test('preserva mensagens não lidas inclusive variantes e parâmetros repetidos', () => {
  const path = '/messages/packs/123/sellers/456';
  assert.equal(validateQuery('meli', path).get('mark_as_read'), 'false');
  assert.equal(validateQuery('meli', path, { mark_as_read: false }).get('mark_as_read'), 'false');
  for (const value of [true, 'true', 'False', ['false', 'true']]) assert.throws(() => validateQuery('meli', path, { mark_as_read: value }));
  for (const key of ['MARK_AS_READ', 'mark_as_read[]']) assert.throws(() => validateQuery('meli', path, { [key]: false }));
});
test('mantém filtros e listas e informa cobertura parcial do guia Meli', () => {
  assert.equal(validateQuery('bling', '/estoques/saldos', { 'idsProdutos[]': [1, 2] }).getAll('idsProdutos[]').join(','), '1,2');
  assert.ok(findResources('bling', 'estoque').total > 0);
  const meli = findResources('meli');
  assert.match(meli.coverage.meli, /não é um inventário exaustivo/);
  validateQuery('meli', '/some/new/official/resource');
});
