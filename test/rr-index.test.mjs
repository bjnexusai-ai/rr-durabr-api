// node --test test/rr-index.test.mjs   (task 4.1a: the wiring in src/index.js, end to end through the REAL Worker entry)
// Rista, MSG91 and PayU are faked at the network (globalThis.fetch); the database is the real migrations through testlib/d1shim.mjs.
// Checks: the checkout is priced by the SAME Rista code as /api/quote, in exact paise; PayU success is confirmed server to server;
// ordering switched off answers 503; the old /api/order test path is locked; /api/quote keeps its rupee fields and adds paise;
// /api/health is unchanged; the cron jobs close an unpaid order and run the daily PayU check.
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { newDb, SKIP } from './_dbroutes.mjs';
import { responseHashString, sha512hex } from '../src/payu.js';

mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-24T09:00:00Z') });   // 14:30 IST: the outlet is open

const CATALOG = { taxTypes: [{ taxTypeId: 'tx1', name: 'GST', percentage: 5 }], categories: [{ categoryId: 'c2', name: 'Starters' }],
  items: [{ type: 'Simple', itemId: 'i6', skuCode: 'S1', itemName: 'Chicken 65', price: 249, categoryId: 'c2', taxTypeIds: ['tx1'], status: 'Active' }] };
const net = { sms: [], payu: { status: 'success', amt: '522.90' }, calls: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)); net.calls.push(u.host + u.pathname);
  const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.host.includes('ristaapps')) {
    const p = u.pathname.replace('/v1', '');
    if (p === '/catalog') return ok(CATALOG);
    if (p === '/stockStatus') return ok({ stockOut: [], stockIn: ['S1'] });
    return ok({});
  }
  if (u.host === 'challenges.cloudflare.com') return ok({ success: String(init.body).includes('turnstile-ok') });
  if (u.host === 'control.msg91.com') { net.sms.push(u.searchParams.get('otp')); return ok({ type: 'success', request_id: 'r1' }); }
  if (u.host === 'test.payu.in') {
    const txn = new URLSearchParams(String(init.body)).get('var1');
    return ok(net.payu.status === 'not_found' ? { status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { [txn]: { status: 'Not Found' } } }
      : { status: 1, transaction_details: { [txn]: { txnid: txn, status: net.payu.status, amt: net.payu.amt, mihpayid: 'pu-1' } } });
  }
  throw new Error('unexpected network call ' + u.href);
};
const { default: worker } = await import('../src/index.js');   // after the fake network, so module-level clients use it

const SALT = 'unit-test-salt-not-a-real-salt-000000';
const PHONE = '9876543210';
const ENV = (db, extra = {}) => ({ DB: db, RISTA_KEY: 'KEY123', RISTA_SECRET: 'SECRET456', CHANNEL: 'Website', ALLOWED_ORIGINS: 'https://site.example',
  ONLINE_ORDER_LIVE: 'true', ONLINE_OUTLETS_LIVE: 'moghalrajpuram', COD_LIVE: 'false', TOKEN_SIGNING_KEY: 'k'.repeat(40), OTP_HASH_SECRET: 'o'.repeat(40),
  PAYMENT_PROVIDER: 'payu', PAYU_MODE: 'test', PAYU_KEY: 'testkey', PAYU_SALT: SALT, OTP_PROVIDER: 'msg91', MSG91_AUTHKEY: 'auth-test', MSG91_TEMPLATE_ID: 'tmpl-1',
  LOYALTY_PROVIDER: 'none', API_ORIGIN: 'https://api.example', SITE_ORIGIN: 'https://site.example', TERMS_VERSION: 'v1', TURNSTILE_SECRET: 'ts-test', ...extra });
const ctx = () => { const w = []; return { waitUntil: (p) => w.push(p), done: () => Promise.all(w) }; };
const call = (env, method, path, { body, headers = {}, raw } = {}) => worker.fetch(new Request('https://api.example' + path, { method,
  headers: { Origin: 'https://site.example', 'Content-Type': raw !== undefined ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
  body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined }), env, ctx());

async function placeOrder(env) {
  const slots = await (await call(env, 'GET', '/api/slots?branch=moghalrajpuram')).json();
  assert.ok(slots.slots && slots.slots.length, 'slots exist at 14:30 IST');
  assert.equal((await call(env, 'POST', '/api/otp/send', { body: { phone: PHONE, purpose: 'checkout', turnstileToken: 'turnstile-ok' } })).status, 200);
  const token = (await (await call(env, 'POST', '/api/otp/verify', { body: { phone: PHONE, code: net.sms.at(-1) } })).json()).token;
  const r = await call(env, 'POST', '/api/checkout/start', { headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `idem-idx-${net.sms.length}-abcdefghij` },
    body: { branch: 'moghalrajpuram', slotId: slots.slots[0].id, method: 'payu', items: [{ id: 'S1', qty: 2 }], customer: { name: 'Asha', email: '' }, consent: { terms: true, marketing: false, version: 'v1' } } });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}

describe('index.js wiring (4.1a)', { skip: SKIP }, () => {
  test('checkout priced by Rista through the same quote code, exact paise; PayU success checked server to server -> PAID', async () => {
    const db = newDb(); const env = ENV(db);
    const o = await placeOrder(env);
    assert.equal(o.totalPaise, 52290, '2 x Rs 249 + 5% GST = Rs 522.90');
    assert.equal(o.payment.fields.amount, '522.90');
    const f = { key: 'testkey', txnid: o.orderId, amount: '522.90', productinfo: 'RR Durbar pickup order', firstname: 'Asha', email: 'orders@rrdurbar.com', status: 'success', mihpayid: 'pu-1' };
    const raw = new URLSearchParams({ ...f, hash: await sha512hex(responseHashString({ ...f, salt: SALT })) }).toString();
    assert.equal((await call(env, 'POST', `/api/payu/callback?t=${encodeURIComponent(o.statusToken)}`, { raw })).status, 303);
    assert.equal((await db.prepare('SELECT state FROM orders WHERE id = ?').bind(o.orderId).first()).state, 'PAID');
    assert.ok(net.calls.includes('test.payu.in/merchant/postservice'), 'PayU was asked server to server');
    const st = await (await call(env, 'GET', `/api/order/status?id=${o.orderId}&t=${o.statusToken}`)).json();
    assert.equal(st.state, 'PAID'); assert.equal(st.totalPaise, 52290);
  });
  test('no Turnstile secret: no SMS is ever sent (fails closed); ordering switched off: 503, status still works', async () => {
    const n = net.sms.length;
    assert.equal((await call(ENV(newDb(), { TURNSTILE_SECRET: '' }), 'POST', '/api/otp/send', { body: { phone: PHONE, purpose: 'checkout' } })).status, 503);
    assert.equal((await call(ENV(newDb()), 'POST', '/api/otp/send', { body: { phone: PHONE, purpose: 'checkout', turnstileToken: 'bad' } })).status, 400);
    assert.equal(net.sms.length, n, 'no SMS sent');
    const env = ENV(newDb(), { ONLINE_ORDER_LIVE: 'false' });
    const r = await call(env, 'POST', '/api/otp/send', { body: { phone: PHONE, purpose: 'checkout' } });
    assert.equal(r.status, 503);
    assert.equal((await call(env, 'GET', '/api/order/status?id=RR-1&t=x')).status, 404);
  });
  test('the old /api/order test path is locked (10.4) unless LEGACY_TEST_ORDER is on', async () => {
    assert.equal((await call(ENV(newDb()), 'POST', '/api/order', { body: {} })).status, 404);
    assert.equal((await call(ENV(newDb(), { COD_TEST_CODE: 'x'.repeat(12) }), 'POST', '/api/order', { body: { code: 'x'.repeat(12), branch: 'ZZ' } })).status, 404, 'locked even with the old secret and the right code');
    assert.notEqual((await call(ENV(newDb(), { LEGACY_TEST_ORDER: 'true', COD_TEST_CODE: 'x'.repeat(12) }), 'POST', '/api/order', { body: { code: 'x'.repeat(12), branch: 'ZZ' } })).status, 404, 'switched on, it reaches the old handler');
  });
  test('/api/quote keeps its rupee fields for the site cart and adds exact paise; /api/health unchanged', async () => {
    const q = await (await call(ENV(newDb()), 'POST', '/api/quote', { body: { branch: 'MR', items: [{ id: 'S1', qty: 2 }] } })).json();
    assert.equal(q.total, 522.9); assert.equal(q.allOk, true); assert.equal(q.totalPaise, 52290); assert.equal(q.paiseOk, true);
    const h = await (await call(ENV(newDb()), 'GET', '/api/health')).json();
    assert.deepEqual(Object.keys(h).sort(), ['configured', 'ok']);
  });
  test('/api/quote: 60 per minute per IP, then 429', async () => {
    const env = ENV(newDb());
    for (let i = 0; i < 60; i++) assert.equal((await call(env, 'POST', '/api/quote', { headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: { branch: 'MR', items: [{ id: 'S1', qty: 1 }] } })).status, 200);
    const r = await call(env, 'POST', '/api/quote', { headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: { branch: 'MR', items: [{ id: 'S1', qty: 1 }] } });
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('Retry-After')) > 0);
  });
  test('cron: an unpaid order 45 minutes old is closed after PayU says it does not exist; the daily check runs', async () => {
    const db = newDb(); const env = ENV(db);
    const o = await placeOrder(env);
    await db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').bind(new Date(Date.now() - 45 * 60000).toISOString(), o.orderId).run();
    net.payu.status = 'not_found';
    const c = ctx(); await worker.scheduled({ cron: '*/10 * * * *' }, env, c); await c.done();
    assert.equal((await db.prepare('SELECT state FROM orders WHERE id = ?').bind(o.orderId).first()).state, 'EXPIRED');
    const d = ctx(); await worker.scheduled({ cron: '30 20 * * *' }, env, d); await d.done();
    net.payu.status = 'success';
  });
});
