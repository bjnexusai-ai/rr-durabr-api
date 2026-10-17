import test from 'node:test';
import assert from 'node:assert/strict';
import { makeQuote, readRequest } from '../src/quote.js';

const CAT = {
  taxTypes: [{ taxTypeId: 'c', percentage: 2.5 }, { taxTypeId: 's', percentage: 2.5 }],
  items: [
    { type: 'Simple', itemId: 'i1', skuCode: 'EX', itemName: 'Excl Dish', price: 405, isPriceIncludesTax: false, taxTypeIds: ['c', 's'], status: 'Active' },
    { type: 'Simple', itemId: 'i2', skuCode: 'IN', itemName: 'Incl Dish', price: 105, isPriceIncludesTax: true, taxTypeIds: ['c', 's'], status: 'Active' },
    { type: 'Simple', itemId: 'i3', skuCode: 'NT', itemName: 'No Tax Dish', price: 100, isPriceIncludesTax: false, status: 'Active' },
    { type: 'Simple', itemId: 'i4', skuCode: 'NP', itemName: 'No Price', status: 'Active' },
    { type: 'Group', itemId: 'i5', skuCode: 'GR', itemName: 'Group Header', status: 'Active' },
  ],
};

test('price WITHOUT tax: Rista tax is added', () => {
  const q = makeQuote(CAT, null, [{ id: 'EX', qty: 2 }]);
  assert.equal(q.subtotal, 810); assert.equal(q.tax, 40.5); assert.equal(q.total, 850.5); assert.equal(q.lines[0].taxIncluded, false);
});
test('price WITH tax: nothing is added, the tax part is only shown', () => {
  const q = makeQuote(CAT, null, [{ id: 'IN', qty: 1 }]);
  assert.equal(q.total, 105); assert.equal(q.tax, 5); assert.equal(q.subtotal, 100); assert.equal(q.taxIncluded, true);
});
test('no tax saved in Rista: no tax added', () => {
  const q = makeQuote(CAT, null, [{ id: 'NT', qty: 3 }]);
  assert.equal(q.total, 300); assert.equal(q.tax, 0);
});
test('mixed cart follows each dish', () => {
  const q = makeQuote(CAT, null, [{ id: 'EX', qty: 1 }, { id: 'IN', qty: 1 }]);
  assert.equal(q.subtotal, 505); assert.equal(q.tax, 25.25); assert.equal(q.total, 530.25);   // 405 + 20.25 tax, and 105 already with tax
});
test('no price, sold out, group row and unknown id cannot be ordered', () => {
  const sold = new Set(['ex']);
  const q = makeQuote(CAT, sold, [{ id: 'NP', qty: 1 }, { id: 'EX', qty: 1 }, { id: 'GR', qty: 1 }, { id: 'ZZ', qty: 1 }]);
  assert.equal(q.allOk, false);
  assert.deepEqual(q.lines.map((l) => l.reason), ['no_price', 'sold_out', 'unknown', 'unknown']);
  assert.equal(q.total, 0);
});
test('request is checked', () => {
  assert.equal(readRequest({ items: [{ id: 'A', qty: 100 }] }).ok, false);
  assert.equal(readRequest({ items: [] }).ok, false);
  assert.equal(readRequest({ items: [{ id: 'A', qty: 2 }, { id: 'A', qty: 3 }] }).items[0].qty, 5);
});
