import test from 'node:test';
import assert from 'node:assert/strict';
import { pricesFor } from '../src/quote.js';
test('prices for the menu cards: only dishes with a Website price, no groups', () => {
  const cat = { items: [
    { type: 'Simple', itemId: 'i1', skuCode: 'A1', itemName: 'Achari Tikka', price: 405, status: 'Active' },
    { type: 'Simple', itemId: 'i2', skuCode: 'A2', itemName: 'No Price', status: 'Active' },
    { type: 'Group', itemId: 'i3', skuCode: 'G1', itemName: 'Header', price: 100, status: 'Active' },
    { type: 'Simple', itemId: 'i4', skuCode: 'A4', itemName: 'Half Dish', price: 220.5, status: 'Active' } ] };
  assert.deepEqual(pricesFor(cat), { A1: 405, A4: 220.5 });
  assert.deepEqual(pricesFor(null), {});
});
