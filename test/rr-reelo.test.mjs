import test from 'node:test'; import assert from 'node:assert/strict';
import { createReelo, ReeloError, normalizePhone, normalizeLoyalty } from '../src/reelo.js';

// Example response from Reelo's docs (comments removed so it is valid JSON)
const DOC = { status_code: 200, response: { loyalty_points: 10000, allow_redemption_today: true, min_bill_for_redemption: 100, total_redeemable_points: 200,
  cashback_redemption: { percentage: 10, fixed: 0, active: true }, redemption_cap_on_max_bill_percentage: 30,
  membership: { active: 'true', type: 'wallet', wallet_credits: '1200', min_bill_for_redemption_membership: 100, total_redeemable_points_membership: 200, redemption_cap_on_max_bill_percentage_membership: 30 },
  coupons: [
    { coupon_name: 'Act now & save Rs.300', coupon_code: 'c1', discount_on: 'bill', discount_type: 'percentage', discount_value: 80, max_discount: '100', special_offer: false, extra_fields: [{ name: 'Reward Type', value: 'Promotion' }] },
    { coupon_name: 'Get a free item', coupon_code: 'c2', discount_on: 'item', discount_type: 'percentage', min_bill_amount_for_redemption: '', discount_value: 100, special_offer: false,
      extra_fields: [{ name: 'Points Value', value: 2000 }, { name: 'Reward Type', value: 'LoyaltyPointTier' }], products: [{ _id: '1019621', quantity: 1 }] },
    { coupon_name: '200 off on entire purchase', coupon_code: 'c3', discount_on: 'bill', discount_type: 'fixed', discount_value: 200, special_offer: false, extra_fields: [{ name: 'Points Value', value: 1000 }] } ] } };

const CFG = (fetchImpl, extra) => Object.assign({ domain: 'https://capture-dev.reelo.io/', vendorId: 'VENDOR-1', branches: { poranki: { merchantId: 'M-PORANKI', customerKey: 'K-PORANKI' } }, fetchImpl }, extra);
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, text: async () => (body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)) });
const spy = (inner) => { const calls = []; const f = async (u, o) => { calls.push({ u, o, body: o.body ? JSON.parse(o.body) : null }); return inner(u, o); }; f.calls = calls; return f; };

test('normalizePhone: strips +91, spaces, leading 0; rejects junk', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210'); assert.equal(normalizePhone('09876543210'), '9876543210'); assert.equal(normalizePhone(9876543210), '9876543210');
  for (const bad of ['12345', '5876543210', '', null, 'abcdefghij']) assert.throws(() => normalizePhone(bad), (e) => e.code === 'bad_phone');
});
test('lookup builds the documented request and normalizes the documented response', async () => {
  const f = spy(reply(200, DOC)); const r = await createReelo(CFG(f)).lookup('poranki', '+91 9876543210');
  const c = f.calls[0];
  assert.equal(c.u, 'https://capture-dev.reelo.io/v1/pos/integrations/VENDOR-1/rewards/customer');
  assert.equal(c.o.headers['Content-Type'], 'application/json'); assert.equal(c.o.method, 'POST');
  assert.deepEqual(c.body, { customer_key: 'K-PORANKI', merchant_id: 'M-PORANKI', customer_mobile: 9876543210, table_number: '', number_of_pepole: '' });
  assert.equal(r.balance, 10000); assert.equal(r.allowRedemptionToday, true);
  assert.deepEqual(r.cashback, { active: true, percentage: 10, fixed: 0, minBill: 100, redeemablePoints: 200, capPercentOfBill: 30 });
  assert.equal(r.membership.active, true); assert.equal(r.membership.walletCredits, 1200); assert.equal(r.membership.type, 'wallet');
  assert.equal(r.coupons.length, 3);
  assert.deepEqual(r.coupons[1], { code: 'c2', name: 'Get a free item', on: 'item', type: 'percentage', value: 100, maxDiscount: 0, minBill: 0, special: false, pointsCost: 2000, rewardType: 'LoyaltyPointTier', products: [{ id: '1019621', qty: 1 }] });
  assert.equal(r.coupons[0].maxDiscount, 100); assert.equal(r.coupons[2].type, 'fixed'); assert.equal(r.coupons[2].pointsCost, 1000);
});
test('lookup with a missing or empty response block is bad_response, not a crash', async () => {
  for (const b of [{ status_code: 200 }, { status_code: 200, response: 'x' }]) await assert.rejects(createReelo(CFG(reply(200, b))).lookup('poranki', '9876543210'), (e) => e.code === 'bad_response');
  await assert.rejects(createReelo(CFG(reply(200, '<html>oops'))).lookup('poranki', '9876543210'), (e) => e.code === 'bad_response');
});
test('unknown outlet or missing config is not_configured and makes NO network call', async () => {
  const f = spy(reply(200, DOC));
  await assert.rejects(createReelo(CFG(f)).lookup('singhnagar', '9876543210'), (e) => e.code === 'not_configured');
  await assert.rejects(createReelo(CFG(f, { vendorId: '' })).lookup('poranki', '9876543210'), (e) => e.code === 'not_configured');
  assert.equal(f.calls.length, 0);
});
test('network failure and timeout map to down; 5xx maps to down; 4xx and inner status_code map to rejected', async () => {
  await assert.rejects(createReelo(CFG(async () => { throw new Error('ECONNRESET https://secret-url'); })).lookup('poranki', '9876543210'), (e) => e.code === 'down' && !/secret|ECONN|reelo\.io/i.test(e.message));
  const slow = (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(createReelo(CFG(slow, { timeoutMs: 30 })).lookup('poranki', '9876543210'), (e) => e.code === 'down');
  await assert.rejects(createReelo(CFG(reply(503, 'busy'))).lookup('poranki', '9876543210'), (e) => e.code === 'down' && e.status === 503);
  await assert.rejects(createReelo(CFG(reply(400, { message: 'bad otp' }))).redeemCoupon('poranki', '9876543210', 'c2', '1234'), (e) => e.code === 'rejected' && e.message === 'bad otp');
  await assert.rejects(createReelo(CFG(reply(200, { status_code: 422, response: { message: 'Coupon already used' } }))).redeemCoupon('poranki', '9876543210', 'c2', '1234'), (e) => e.code === 'rejected' && /already used/.test(e.message));
});
test('errors never contain keys, ids or phone numbers', async () => {
  for (const make of [() => createReelo(CFG(reply(500, 'x'))).lookup('poranki', '9876543210'), () => createReelo(CFG(reply(400, 'nope'))).lookup('poranki', '9876543210')])
    await assert.rejects(make(), (e) => !/K-PORANKI|M-PORANKI|VENDOR-1|9876543210/.test(e.message + JSON.stringify(e)));
});
test('sendRedeemOtp sends coupon_code, points or wallet_credits exactly as documented, in the configured phone field', async () => {
  let f = spy(reply(200, { status_code: 200, response: { points_value: 0 } }));
  const r = await createReelo(CFG(f)).sendRedeemOtp('poranki', '9876543210', { couponCode: 'c2' });
  assert.equal(f.calls[0].u, 'https://capture-dev.reelo.io/v1/pos/integrations/VENDOR-1/points/authenticate');
  assert.deepEqual(f.calls[0].body, { customer_key: 'K-PORANKI', merchant_id: 'M-PORANKI', customer_mobile: '9876543210', coupon_code: 'c2' }); assert.deepEqual(r, { sent: true, pointsValue: 0 });
  f = spy(reply(200, { status_code: 200, response: {} })); await createReelo(CFG(f, { authPhoneField: 'both' })).sendRedeemOtp('poranki', '9876543210', { points: 100 });
  assert.deepEqual(f.calls[0].body, { customer_key: 'K-PORANKI', merchant_id: 'M-PORANKI', customer_mobile: '9876543210', phone: '9876543210', points: '100' });
  await assert.rejects(createReelo(CFG(f)).sendRedeemOtp('poranki', '9876543210', {}), (e) => e.code === 'rejected');
});
test('redeemCoupon and redeemPoints follow the docs; redeemPoints accepts the empty body', async () => {
  let f = spy(reply(200, { status_code: 200, response: { message: 'Coupon successfully redeemed.' } }));
  const a = await createReelo(CFG(f)).redeemCoupon('poranki', '9876543210', 'c2', '4191');
  assert.equal(f.calls[0].u, 'https://capture-dev.reelo.io/v1/pos/integrations/VENDOR-1/redeem/coupon');
  assert.deepEqual(f.calls[0].body, { customer_key: 'K-PORANKI', merchant_id: 'M-PORANKI', customer_mobile: '9876543210', coupon_code: 'c2', otp: '4191' }); assert.equal(a.message, 'Coupon successfully redeemed.');
  f = spy(reply(200, null)); const b = await createReelo(CFG(f)).redeemPoints('poranki', '9876543210', 100, '4191', '1200');
  assert.equal(f.calls[0].u, 'https://capture-dev.reelo.io/v1/pos/integrations/VENDOR-1/redeem/points');
  assert.deepEqual(f.calls[0].body, { customer_key: 'K-PORANKI', merchant_id: 'M-PORANKI', customer_mobile: '9876543210', points: 100, otp: '4191', wallet_credits: '1200' }); assert.deepEqual(b, { redeemed: true, confirmWithLookup: true });
  await assert.rejects(createReelo(CFG(f)).redeemCoupon('poranki', '9876543210', 'c2', 'abc'), (e) => e.code === 'rejected');
});
test('undocumented endpoints refuse to guess', async () => {
  const r = createReelo(CFG(reply(200, DOC)));
  for (const m of ['captureBill', 'editBill', 'revertPoints', 'saleReturn', 'pushMenu', 'pushPaymentTypes']) await assert.rejects(r[m](), (e) => e.code === 'not_documented');
});
test('normalizeLoyalty is safe on a nearly empty response', () => {
  const n = normalizeLoyalty({}); assert.equal(n.balance, 0); assert.deepEqual(n.coupons, []); assert.equal(n.allowRedemptionToday, false); assert.equal(n.membership.active, false);
});
