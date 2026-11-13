// node --test test/rr-payu-pending.test.mjs   (PayU status=pending must never fail an order; reuses the helpers of rr-payu-cases)
// success, failure, cancel, closed tab (webhook only), duplicate callback + webhook, wrong hash, amount tampering,
// late success after a failure, and a failure arriving after PAID. Only the outside world is faked.
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

function world() {
  const db = newDb();
  const sms = [], pushes = [];
  const state = { payu: 'success', amt: '732.90', verifyCalls: 0 };
  const outside = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://control.msg91.com/')) { sms.push(new URL(u).searchParams.get('otp')); return { ok: true, status: 200, json: async () => ({ type: 'success', request_id: 'r1' }) }; }
    if (u.startsWith('https://test.payu.in/merchant/postservice')) {
      state.verifyCalls++;
      const txn = new URLSearchParams(String(init.body)).get('var1');
      return { ok: true, status: 200, json: async () => ({ status: 1, transaction_details: { [txn]: { txnid: txn, status: state.payu, amt: state.amt, mihpayid: 'pu-777' } } }) };
    }
    throw new Error('unexpected outside call ' + u);
  };
  const rq = { allOk: true, subtotal: 698, tax: 34.9, total: 732.9, lines: [{ id: 'r1', ok: true, name: 'Chicken Dum Biryani', lineTotal: 698 }] };
  const deps = {
    now: () => NOW,
    verifyTurnstile: async (env, token) => token === 'turnstile-ok',
    makeSender: (env) => makeSender(env, { fetchImpl: outside }),
    loyaltyLookup: makeLoyaltyLookup({ fetchImpl: outside }),
    payuVerify: makePayuVerify({ fetchImpl: outside }),
    quote: makeOrderingQuote(async () => rq),
    pushToRista: async (env, o) => { pushes.push(o.orderId); },
  };
  const env = { DB: db, ONLINE_ORDER_LIVE: 'true', ONLINE_OUTLETS_LIVE: 'moghalrajpuram', COD_LIVE: 'false', COD_MAX_TOTAL: '1000',
    TOKEN_SIGNING_KEY: 'k'.repeat(40), OTP_HASH_SECRET: 'o'.repeat(40), PAYMENT_PROVIDER: 'payu', PAYU_MODE: 'test', PAYU_KEY: 'testkey', PAYU_SALT: SALT,
    OTP_PROVIDER: 'msg91', MSG91_AUTHKEY: 'auth-test', MSG91_TEMPLATE_ID: 'tmpl-1', LOYALTY_PROVIDER: 'none',
    API_ORIGIN: 'https://api.example', SITE_ORIGIN: 'https://site.example', ALLOWED_ORIGINS: 'https://site.example', TERMS_VERSION: 'v1' };
  const waits = [];
  const ctx = { waitUntil(p) { waits.push(p); } };
  const handle = createOrderingHandler(deps);
  const call = (method, path, { body, headers = {}, raw } = {}) => handle(new Request('https://api.example' + path, { method,
    headers: { 'Content-Type': raw !== undefined ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined }), env, ctx);
  const settle = () => Promise.all(waits.splice(0));
  return { db, sms, pushes, state, call, settle };
}

async function order(w, n = 1) {
  if (!w.token) {
    assert.equal((await w.call('POST', '/api/otp/send', { body: { phone: PHONE, purpose: 'checkout', turnstileToken: 'turnstile-ok' } })).status, 200);
    w.token = (await (await w.call('POST', '/api/otp/verify', { body: { phone: PHONE, code: w.sms[0] } })).json()).token;
  }
  const r = await w.call('POST', '/api/checkout/start', { headers: { Authorization: `Bearer ${w.token}`, 'Idempotency-Key': `idem-75-${n}-abcdefghijkl` },
    body: { branch: 'moghalrajpuram', slotId: SLOT, method: 'payu', items: [{ id: 'r1', qty: 2 }], customer: { name: 'Asha', email: '' }, consent: { terms: true, marketing: false, version: 'v1' } } });
  assert.equal(r.status, 200);
  return r.json();
}
async function post(o, { status = 'success', amount = '732.90', hash, tamperAmount } = {}) {
  const f = { key: 'testkey', txnid: o.orderId, amount, productinfo: 'RR Durbar pickup order', firstname: 'Asha', email: 'orders@rrdurbar.com', status, mihpayid: 'pu-777' };
  const h = hash ?? await sha512hex(responseHashString({ ...f, salt: SALT }));
  return new URLSearchParams({ ...f, ...(tamperAmount ? { amount: tamperAmount } : {}), hash: h }).toString();
}
const st = async (w, o) => (await w.db.prepare('SELECT state FROM orders WHERE id = ?').bind(o.orderId).first()).state;
const pays = async (w, o) => (await w.db.prepare('SELECT status FROM payments WHERE order_id = ?').bind(o.orderId).all()).results.map((r) => r.status);
const cb = (w, o, raw) => w.call('POST', `/api/payu/callback?t=${encodeURIComponent(o.statusToken)}`, { raw });
const hook = (w, raw) => w.call('POST', '/api/payu/webhook', { raw });


describe('PayU status=pending', { skip: SKIP }, () => {
  test('pending callback: order keeps waiting (not failed), PayU not asked, no push; a later success still pays it', async () => {
    const w = world(); const o = await order(w);
    const r = await cb(w, o, await post(o, { status: 'pending' }));
    assert.equal(r.status, 303);
    assert.equal(await st(w, o), 'PAYMENT_PENDING');
    assert.deepEqual(await pays(w, o), ['INITIATED']);
    assert.equal(w.state.verifyCalls, 0);
    assert.equal(w.pushes.length, 0);
    await hook(w, await post(o));
    await w.settle();
    assert.equal(await st(w, o), 'PAID');
    assert.deepEqual(w.pushes, [o.orderId]);
  });
  test('pending webhook: answers 200, order keeps waiting', async () => {
    const w = world(); const o = await order(w);
    assert.equal((await hook(w, await post(o, { status: 'pending' }))).status, 200);
    assert.equal(await st(w, o), 'PAYMENT_PENDING');
    assert.deepEqual(await pays(w, o), ['INITIATED']);
    assert.equal(w.pushes.length, 0);
  });
});
