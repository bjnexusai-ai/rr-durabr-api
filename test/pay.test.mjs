import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentOptions, checkMethod, codMaxPaiseFromEnv, paiseToRupeeString } from '../src/pay.js';

test('Rs 1000.00 offers payu and cod; Rs 1000.01 offers payu only', () => {
  assert.deepEqual(paymentOptions(100000), ['payu', 'cod']);
  assert.deepEqual(paymentOptions(100001), ['payu']);
  assert.deepEqual(paymentOptions(99999), ['payu', 'cod']);
});
test('a forced cod request above the limit is rejected by the server check', () => {
  assert.deepEqual(checkMethod('cod', 100001), { ok: false, code: 'method_not_allowed' });
  assert.deepEqual(checkMethod('cod', 100000), { ok: true });
  assert.deepEqual(checkMethod('upi', 500), { ok: false, code: 'bad_method' });
});
test('outlet that does not allow cod never offers it', () => {
  assert.deepEqual(paymentOptions(5000, { codAllowedForBranch: false }), ['payu']);
});
test('COD_MAX_TOTAL is rupees, capped at the database ceiling, bad value falls back', () => {
  assert.equal(codMaxPaiseFromEnv({ COD_MAX_TOTAL: '1000' }), 100000);
  assert.equal(codMaxPaiseFromEnv({ COD_MAX_TOTAL: '500' }), 50000);
  assert.equal(codMaxPaiseFromEnv({ COD_MAX_TOTAL: '5000' }), 100000);
  assert.equal(codMaxPaiseFromEnv({ COD_MAX_TOTAL: 'abc' }), 100000);
  assert.equal(codMaxPaiseFromEnv({}), 100000);
});
test('floats and non-positive totals are refused', () => {
  assert.throws(() => paymentOptions(10.5));
  assert.throws(() => paymentOptions(0));
  assert.equal(paiseToRupeeString(68040), '680.40');
  assert.equal(paiseToRupeeString(5), '0.05');
});
