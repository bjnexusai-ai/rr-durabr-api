// node --test test/rr-wiring.test.mjs
// End to end through the REAL routes (src/ordering.js) and the REAL migrations, with the new modules plugged in the way
// src/index.js will plug them in (task 4.1). Only the outside world is faked: MSG91, Reelo, PayU and the Rista quote.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newDb, SKIP } from './_dbroutes.mjs';
import { createOrderingHandler } from '../src/ordering.js';
import { makeSender } from '../src/msg91.js';
import { makeLoyaltyLookup } from '../src/loyalty.js';
import { makePayuVerify } from '../src/payuverify.js';
import { makeOrderingQuote } from '../src/quotemoney.js';
import { responseHashString, sha512hex } from '../src/payu.js';

const NOW = new Date('2026-10-24T09:00:00Z');
const SLOT = '2026-10-24T09:30:00.000Z';
const SALT = 'unit-test-salt-not-a-real-salt-000000';
const PHONE = '9876543210';

function world({ payuStatus = 'success', payuAmt, rupeeQuote } = {}) {
  const db = newDb();
  const sms = [];
  const outside = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://control.msg91.com/')) { sms.push(new URL(u).searchParams.get('otp')); return { ok: true, status: 200, json: async () => ({ type: 'success', request_id: 'r1' }) }; }
    if (u.startsWith('https://reelo.test/')) return { ok: true, status: 200, text: async () => JSON.stringify({ status_code: 200, response: { loyalty_points: 120, coupons: [] } }) };
    if (u.startsWith('https://test.payu.in/merchant/postservice')) {
      const txn = new URLSearchParams(String(init.body)).get('var1');
      return { ok: true, status: 200, json: async () => ({ status: 1, transaction_details: { [txn]: { txnid: txn, status: payuStatus, amt: payuAmt ?? '732.90', mihpayid: 'pu-777' } } }) };
    }
    throw new Error('unexpected outside call ' + u);
  };
  const rq = rupeeQuote || { allOk: true, subtotal: 698, tax: 34.9, total: 732.9, lines: [{ id: 'r1', ok: true, name: 'Chicken Dum Biryani', lineTotal: 698 }] };
  const deps = {
    now: () => NOW,
    verifyTurnstile: async (env, token) => token === 'turnstile-ok',   // production runs Cloudflare's check; faked here
    makeSender: (env) => makeSender(env, { fetchImpl: outside }),
    loyaltyLookup: makeLoyaltyLookup({ fetchImpl: outside }),
    payuVerify: makePayuVerify({ fetchImpl: outside }),
    quote: makeOrderingQuote(async () => rq),
  };
  const env = { DB: db, ONLINE_ORDER_LIVE: 'true', ONLINE_OUTLETS_LIVE: 'moghalrajpuram', COD_LIVE: 'true', COD_OUTLETS: 'moghalrajpuram', COD_MAX_TOTAL: '1000',
    TOKEN_SIGNING_KEY: 'k'.repeat(40), OTP_HASH_SECRET: 'o'.repeat(40), PAYMENT_PROVIDER: 'payu', PAYU_MODE: 'test', PAYU_KEY: 'testkey', PAYU_SALT: SALT,
    OTP_PROVIDER: 'msg91', MSG91_AUTHKEY: 'auth-test', MSG91_TEMPLATE_ID: 'tmpl-1',
    LOYALTY_PROVIDER: 'reelo', REELO_DOMAIN: 'https://reelo.test', REELO_VENDOR_ID: 'v1', REELO_MR_MERCHANT_ID: 'm', REELO_MR_CUSTOMER_KEY: 'k',
    API_ORIGIN: 'https://api.example', SITE_ORIGIN: 'https://site.example', ALLOWED_ORIGINS: 'https://site.example', TERMS_VERSION: 'v1' };
  const handle = createOrderingHandler(deps);
  const call = (method, path, { body, headers = {}, raw } = {}) => handle(new Request('https://api.example' + path, { method, headers: { 'Content-Type': raw !== undefined ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
  return { db, sms, call };
}

async function login(w) {
  assert.equal((await w.call('POST', '/api/otp/send', { body: { phone: PHONE, purpose: 'checkout', turnstileToken: 'turnstile-ok' } })).status, 200);
  assert.equal(w.sms.length, 1, 'MSG91 was asked to send exactly one SMS');
  const v = await w.call('POST', '/api/otp/verify', { body: { phone: PHONE, code: w.sms[0] } });
  assert.equal(v.status, 200);
  return (await v.json()).token;
}
const startBody = (method = 'payu') => ({ branch: 'moghalrajpuram', slotId: SLOT, method, items: [{ id: 'r1', qty: 2 }], customer: { name: 'Asha', email: '' }, consent: { terms: true, marketing: false, version: 'v1' } });
async function payuPost(o, status = 'success') {
  const f = { key: 'testkey', txnid: o.orderId, amount: '732.90', productinfo: 'RR Durbar pickup order', firstname: 'Asha', email: 'orders@rrdurbar.com', status, mihpayid: 'pu-777' };
  const hash = await sha512hex(responseHashString({ ...f, salt: SALT }));
  return new URLSearchParams({ ...f, hash }).toString();
}

describe('new modules plugged into the real routes', { skip: SKIP }, () => {
  test('without a passed Turnstile check no SMS is sent', async () => {
    const w = world();
    const r = await w.call('POST', '/api/otp/send', { body: { phone: PHONE, purpose: 'checkout', turnstileToken: 'bad' } });
    assert.equal(r.status, 400);
    assert.equal(w.sms.length, 0);
  });
  test('SMS code -> rewards balance -> order from the rupee quote -> PayU success -> server check -> PAID', async () => {
    const w = world();
    const token = await login(w);
    const l = await (await w.call('POST', '/api/loyalty/lookup', { body: { branch: 'moghalrajpuram' }, headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(l.available, true); assert.equal(l.balance, 120);
    const s = await w.call('POST', '/api/checkout/start', { body: startBody(), headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'idem-0001-abcdefghijkl' } });
    assert.equal(s.status, 200);
    const o = await s.json();
    assert.equal(o.totalPaise, 73290); assert.equal(o.payment.fields.amount, '732.90');
    const cb = await w.call('POST', `/api/payu/callback?t=${encodeURIComponent(o.statusToken)}`, { raw: await payuPost(o) });
    assert.equal(cb.status, 303);
    const row = await w.db.prepare('SELECT state FROM orders WHERE id = ?').bind(o.orderId).first();
    assert.equal(row.state, 'PAID');
    const pay = await w.db.prepare('SELECT status, payu_ref, amount_paise FROM payments WHERE order_id = ?').bind(o.orderId).first();
    assert.deepEqual(pay, { status: 'SUCCESS', payu_ref: 'pu-777', amount_paise: 73290 });
  });

  test('a good-looking PayU post is NOT enough: if PayU\'s own check says failure, the order stays unpaid', async () => {
    const w = world({ payuStatus: 'failure' });
    const token = await login(w);
    const o = await (await w.call('POST', '/api/checkout/start', { body: startBody(), headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'idem-0002-abcdefghijkl' } })).json();
    await w.call('POST', `/api/payu/callback?t=${encodeURIComponent(o.statusToken)}`, { raw: await payuPost(o) });
    assert.equal((await w.db.prepare('SELECT state FROM orders WHERE id = ?').bind(o.orderId).first()).state, 'PAYMENT_PENDING');
  });

  test('PayU\'s check reports a different amount: no PAID, payment flagged MISMATCH', async () => {
    const w = world({ payuAmt: '1.00' });
    const token = await login(w);
    const o = await (await w.call('POST', '/api/checkout/start', { body: startBody(), headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'idem-0003-abcdefghijkl' } })).json();
    await w.call('POST', `/api/payu/callback?t=${encodeURIComponent(o.statusToken)}`, { raw: await payuPost(o) });
    assert.equal((await w.db.prepare('SELECT state FROM orders WHERE id = ?').bind(o.orderId).first()).state, 'PAYMENT_PENDING');
    assert.equal((await w.db.prepare('SELECT status FROM payments WHERE order_id = ?').bind(o.orderId).first()).status, 'MISMATCH');
  });

  test('a rupee quote that does not add up is refused before any order is written', async () => {
    const w = world({ rupeeQuote: { allOk: true, subtotal: 698, tax: 34.9, total: 732.91, lines: [{ id: 'r1', ok: true, name: 'X', lineTotal: 698 }] } });
    const token = await login(w);
    const r = await w.call('POST', '/api/checkout/start', { body: startBody(), headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'idem-0004-abcdefghijkl' } });
    assert.equal(r.status, 503);
    assert.equal((await w.db.prepare('SELECT COUNT(*) AS n FROM orders').first()).n, 0);
  });

  test('pay at pickup (Rs 732.90, under Rs 1000) is created without PayU', async () => {
    const w = world();
    const token = await login(w);
    const r = await w.call('POST', '/api/checkout/start', { body: startBody('cod'), headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'idem-0005-abcdefghijkl' } });
    assert.equal(r.status, 200);
    const o = await r.json();
    assert.equal(o.payment, null); assert.equal(o.state, 'CREATED');
  });
});
