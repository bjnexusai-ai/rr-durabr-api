// node --test test/providers.test.mjs   (no network: MSG91, Reelo and the database are faked or local)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeSender, msg91Sender } from '../src/msg91.js';
import { makeLoyaltyLookup, reeloConfig } from '../src/loyalty.js';
import { createHealthHandler, missingConfig } from '../src/health.js';
import { rupeesToPaiseExact, toOrderingQuote, withPaiseFields, makeOrderingQuote } from '../src/quotemoney.js';

const fakeFetch = (reply, seen = [], status = 200) => async (url, init) => { seen.push({ url: String(url), init }); if (reply instanceof Error) throw reply; return { ok: status >= 200 && status < 300, status, json: async () => reply, text: async () => JSON.stringify(reply) }; };

describe('MSG91 sender (5.1)', () => {
  const ENV = { OTP_PROVIDER: 'msg91', MSG91_AUTHKEY: 'auth-test', MSG91_TEMPLATE_ID: 'tmpl-1' };
  test('sends the v5 request: template, 91+mobile, our code, authkey header, code in the body', async () => {
    const seen = [];
    const s = makeSender(ENV, { fetchImpl: fakeFetch({ type: 'success', request_id: 'abc' }, seen) });
    assert.deepEqual(await s.send('9876543210', '123456'), { ok: true, requestId: 'abc' });
    const u = new URL(seen[0].url);
    assert.equal(u.origin + u.pathname, 'https://control.msg91.com/api/v5/otp');
    assert.equal(u.searchParams.get('template_id'), 'tmpl-1');
    assert.equal(u.searchParams.get('mobile'), '919876543210');
    assert.equal(u.searchParams.get('otp'), '123456');
    assert.equal(u.searchParams.get('otp_length'), '6');
    assert.equal(seen[0].init.headers.authkey, 'auth-test');
    assert.deepEqual(JSON.parse(seen[0].init.body), { OTP: '123456' });
    assert.ok(!seen[0].url.includes('auth-test'), 'authkey is never in the URL');
  });
  test('an error reply with HTTP 200, an HTTP error or no network all count as failed', async () => {
    assert.equal((await msg91Sender(ENV, { fetchImpl: fakeFetch({ type: 'error', message: 'Invalid template' }) }).send('9876543210', '123456')).ok, false);
    assert.equal((await msg91Sender(ENV, { fetchImpl: fakeFetch({ type: 'success' }, [], 401) }).send('9876543210', '123456')).ok, false);
    assert.equal((await msg91Sender(ENV, { fetchImpl: fakeFetch(new Error('down')) }).send('9876543210', '123456')).ok, false);
    assert.equal((await msg91Sender(ENV, { fetchImpl: fakeFetch({ type: 'success' }) }).send('12345', '123456')).ok, false);
  });
  test('closed by default: no keys, unknown provider, or mock without ALLOW_MOCKS give no sender', () => {
    assert.equal(makeSender({ OTP_PROVIDER: 'msg91' }), null);
    assert.equal(makeSender({}), null);
    assert.equal(makeSender({ OTP_PROVIDER: 'mock' }), null);
    assert.ok(makeSender({ OTP_PROVIDER: 'mock', ALLOW_MOCKS: 'true' }));
  });
});

describe('Reelo balance lookup (9.1b)', () => {
  const ENV = { LOYALTY_PROVIDER: 'reelo', REELO_DOMAIN: 'https://reelo.test', REELO_VENDOR_ID: 'v1', REELO_MR_MERCHANT_ID: 'm-mr', REELO_MR_CUSTOMER_KEY: 'k-mr' };
  test('maps the ordering outlet slug to that outlet\'s Reelo keys and returns balance and rewards count', async () => {
    const seen = [];
    const look = makeLoyaltyLookup({ fetchImpl: fakeFetch({ status_code: 200, response: { loyalty_points: 340, coupons: [{ coupon_code: 'c1' }] } }, seen) });
    assert.deepEqual(await look(ENV, { phone: '9876543210', branch: 'moghalrajpuram' }), { available: true, member: true, balance: 340, rewardsCount: 1 });
    assert.equal(seen[0].url, 'https://reelo.test/v1/pos/integrations/v1/rewards/customer');
    const b = JSON.parse(seen[0].init.body);
    assert.equal(b.merchant_id, 'm-mr'); assert.equal(b.customer_key, 'k-mr'); assert.equal(b.customer_mobile, 9876543210);
  });
  test('a number Reelo does not know is balance 0, not an error; Reelo down or an outlet without keys is "unavailable"', async () => {
    const nf = makeLoyaltyLookup({ fetchImpl: fakeFetch({ status_code: 400, message: 'Customer not found' }, [], 400) });
    assert.deepEqual(await nf(ENV, { phone: '9876543210', branch: 'moghalrajpuram' }), { available: true, member: false, balance: 0, rewardsCount: 0 });
    assert.deepEqual(await makeLoyaltyLookup({ fetchImpl: fakeFetch(new Error('x')) })(ENV, { phone: '9876543210', branch: 'moghalrajpuram' }), { available: false });
    assert.deepEqual(await makeLoyaltyLookup({ fetchImpl: fakeFetch({ status_code: 200, response: {} }) })(ENV, { phone: '9876543210', branch: 'poranki' }), { available: false });
  });
  test('provider off, or mock without ALLOW_MOCKS, is unavailable; keys are read per Rista code', async () => {
    assert.deepEqual(await makeLoyaltyLookup()({}, { phone: '9876543210', branch: 'poranki' }), { available: false });
    assert.deepEqual(await makeLoyaltyLookup()({ LOYALTY_PROVIDER: 'mock' }, { phone: '9876543210', branch: 'poranki' }), { available: false });
    assert.equal((await makeLoyaltyLookup()({ LOYALTY_PROVIDER: 'mock', ALLOW_MOCKS: 'true' }, { phone: '9999900001', branch: 'poranki' })).balance, 240);
    assert.deepEqual(Object.keys(reeloConfig(ENV).branches), ['moghalrajpuram']);
  });
});

describe('health and admin self-check (10.8)', () => {
  const h = createHealthHandler({ getDb: (env) => env.DB, getKv: (env) => env.KV });
  const db = { prepare: () => ({ first: async () => ({ n: 0 }) }) };
  const req = (p, headers = {}) => new Request('https://api.example' + p, { headers });
  test('other paths are left alone; public health says only open or closed', async () => {
    assert.equal(await h(req('/api/menu'), {}), null);
    const j = await (await h(req('/api/health'), { ONLINE_ORDER_LIVE: 'false', PAYU_SALT: 'secret-salt' })).json();
    assert.deepEqual(j, { ok: true, ordering: { open: false, outlets: [] } });
  });
  test('self-check needs the admin key and lists missing NAMES only, never values', async () => {
    const env = { DB: db, KV: {}, ADMIN_KEY: 'a'.repeat(40), PAYMENT_PROVIDER: 'payu', PAYU_KEY: 'kkk', TOKEN_SIGNING_KEY: 'short' };
    assert.equal((await h(req('/api/admin/selfcheck'), env)).status, 404);
    assert.equal((await h(req('/api/admin/selfcheck', { 'x-admin-key': 'wrong' }), env)).status, 404);
    const res = await h(req('/api/admin/selfcheck', { 'x-admin-key': 'a'.repeat(40) }), env);
    const text = await res.text(), j = JSON.parse(text);
    assert.equal(j.bindings.DBQuery, true);
    assert.ok(j.missing.includes('PAYU_SALT')); assert.ok(j.missing.includes('TOKEN_SIGNING_KEY (too short)'));
    assert.ok(!text.includes('kkk') && !text.includes('short"'), 'no secret values in the answer');
  });
  test('a short ADMIN_KEY disables the self-check', async () => {
    assert.equal((await h(req('/api/admin/selfcheck', { 'x-admin-key': 'abc' }), { ADMIN_KEY: 'abc' })).status, 404);
    assert.ok(missingConfig({}).includes('RISTA_KEY'));
  });
});

describe('rupee quote to exact paise (4.1a, 4.5a)', () => {
  const Q = { allOk: true, subtotal: 698, tax: 34.9, total: 732.9, lines: [{ id: 'r1', ok: true, name: 'Chicken Dum Biryani', lineTotal: 698 }] };
  const ITEMS = [{ id: 'r1', qty: 2 }];
  test('rupees become paise exactly, never by guessing', () => {
    assert.equal(rupeesToPaiseExact(349), 34900); assert.equal(rupeesToPaiseExact(18.45), 1845); assert.equal(rupeesToPaiseExact('34.90'), 3490);
    assert.equal(rupeesToPaiseExact(18.456), null); assert.equal(rupeesToPaiseExact(-1), null); assert.equal(rupeesToPaiseExact('abc'), null);
  });
  test('a correct quote gives the shape checkout/start needs', () => {
    assert.deepEqual(toOrderingQuote(Q, ITEMS), { ok: true, quote: { items: [{ id: 'r1', name: 'Chicken Dum Biryani', qty: 2, unitPaise: 34900, linePaise: 69800 }], subtotalPaise: 69800, taxPaise: 3490, chargesPaise: 0, totalPaise: 73290 } });
  });
  test('one paisa off anywhere refuses the order instead of charging it', () => {
    assert.equal(toOrderingQuote({ ...Q, total: 732.91 }, ITEMS).why, 'parts_ne_total');
    assert.equal(toOrderingQuote({ ...Q, subtotal: 698.01 }, ITEMS).why, 'lines_ne_subtotal');
    assert.equal(toOrderingQuote({ ...Q, lines: [{ ...Q.lines[0], lineTotal: 698.01 }], subtotal: 698.01, total: 732.91 }, ITEMS).why, 'unit_not_whole_paise:r1');
    assert.equal(toOrderingQuote({ ...Q, lines: [{ ...Q.lines[0], qty: 2 }] }, [{ id: 'r1', qty: 3 }]).why, 'qty_changed:r1');
    assert.equal(toOrderingQuote(Q, [...ITEMS, { id: 'r2', qty: 1 }]).why, 'lines_do_not_match_cart');
    assert.equal(toOrderingQuote({ ...Q, charges: 10, total: 742.9 }, ITEMS).quote.chargesPaise, 1000);
  });
  test('sold out becomes item_unavailable with the item id', () => {
    assert.deepEqual(toOrderingQuote({ ...Q, allOk: false, lines: [{ id: 'r1', ok: false, reason: 'sold_out' }] }, ITEMS), { ok: false, code: 'item_unavailable', field: 'r1' });
  });
  test('the site cart keeps its rupee fields; the checkout gets paise fields beside them', () => {
    const w = withPaiseFields(Q, ITEMS);
    assert.equal(w.total, 732.9); assert.equal(w.lines.length, 1); assert.equal(w.allOk, true);
    assert.equal(w.totalPaise, 73290); assert.equal(w.items[0].unitPaise, 34900); assert.equal(w.paiseOk, true);
    assert.equal(withPaiseFields({ ...Q, total: 1 }, ITEMS).paiseOk, false);
  });
  test('the adapter turns a Rista failure into provider_down', async () => {
    const q = makeOrderingQuote(async () => { throw new Error('rista down'); });
    assert.deepEqual(await q({}, { ristaCode: 'MR', items: ITEMS }), { ok: false, code: 'provider_down' });
    assert.equal((await makeOrderingQuote(async () => Q)({}, { ristaCode: 'MR', items: ITEMS })).ok, true);
  });
});
