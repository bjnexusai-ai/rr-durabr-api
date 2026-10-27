import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newDb, SKIP } from './_dbroutes.mjs';
import { createOrderingHandler } from '../src/ordering.js';
import { mockSender } from '../src/otp.js';
import { responseHashString, sha512hex } from '../src/payu.js';
import { paiseToRupeeString } from '../src/pay.js';
import { verifyToken } from '../src/token.js';

const NOW = new Date('2026-10-24T09:00:00Z'); // 14:30 in India
const SLOT = '2026-10-24T09:30:00.000Z';      // 15:00 India: first slot with 30 min prep
const SALT = 'unit-test-salt-not-a-real-salt-000000';
const KEYS = { TOKEN_SIGNING_KEY: 'k'.repeat(40), OTP_HASH_SECRET: 'o'.repeat(40) };
const baseEnv = (db, over = {}) => ({ DB: db, ONLINE_ORDER_LIVE: 'true', ONLINE_OUTLETS_LIVE: 'moghalrajpuram,poranki', COD_LIVE: 'true', COD_OUTLETS: 'moghalrajpuram', COD_MAX_TOTAL: '1000',
  ...KEYS, PAYU_KEY: 'testkey', PAYU_SALT: SALT, API_ORIGIN: 'https://api.example', SITE_ORIGIN: 'https://site.example', ALLOWED_ORIGINS: 'https://site.example', TERMS_VERSION: 'v1', ALLOW_MOCKS: 'true', ...over });

function mk(over = {}, depsOver = {}) {
  const db = newDb();
  const sender = mockSender();
  const Q = { unit: 30000, taxPct: 5, fail: null, calls: 0 };
  const quote = async (env, { items }) => {
    Q.calls++;
    if (Q.fail === 'provider_down') return { ok: false, code: 'provider_down' };
    if (Q.fail === 'item_unavailable') return { ok: false, code: 'item_unavailable', field: items[0].id };
    const lines = items.map((i) => ({ id: i.id, name: `Dish ${i.id}`, qty: i.qty, unitPaise: Q.unit, linePaise: Q.unit * i.qty }));
    const subtotalPaise = lines.reduce((a, l) => a + l.linePaise, 0);
    const taxPaise = Math.round(subtotalPaise * Q.taxPct / 100);
    return { ok: true, quote: { items: lines, subtotalPaise, taxPaise, chargesPaise: 0, totalPaise: subtotalPaise + taxPaise, earnPoints: Math.floor(subtotalPaise / 100) } };
  };
  const payuVerifyCalls = [];
  const deps = { now: () => NOW, makeSender: () => sender, quote, payuVerify: async (env, txn) => { payuVerifyCalls.push(txn); return Q.verify ? Q.verify(txn) : null; }, ...depsOver };
  const env = baseEnv(db, over);
  const handle = createOrderingHandler(deps);
  const ctx = { waitUntil: () => {} };
  const call = (method, path, { body, headers = {}, raw, ct } = {}) => handle(new Request('https://api.example' + path, { method, headers: { ...(raw !== undefined ? { 'Content-Type': ct || 'application/x-www-form-urlencoded' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined }), env, ctx);
  const json = async (res) => JSON.parse(await res.text());
  const login = async (phone = '9876543210') => {
    const s = await call('POST', '/api/otp/send', { body: { phone, purpose: 'checkout' } });
    assert.equal(s.status, 200, 'otp send');
    const code = sender.sent.at(-1).code;
    const v = await call('POST', '/api/otp/verify', { body: { phone, code } });
    assert.equal(v.status, 200, 'otp verify');
    return (await json(v)).token;
  };
  let n = 0;
  const idem = () => `idem-${String(++n).padStart(4, '0')}-abcdefghijkl`;
  const body = (over2 = {}) => ({ branch: 'moghalrajpuram', slotId: SLOT, method: 'payu', items: [{ id: 'r1', qty: 2 }], customer: { name: 'Asha', email: '' }, consent: { terms: true, marketing: false, version: 'v1' }, ...over2 });
  const start = (token, b = body(), key = idem()) => call('POST', '/api/checkout/start', { body: b, headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key } });
  const count = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
  const payuPost = (o, status = 'success', over2 = {}) => {
    const f = { key: 'testkey', txnid: o.orderId, amount: paiseToRupeeString(o.totalPaise), productinfo: 'RR Durbar pickup order', firstname: 'Asha', email: 'orders@rrdurbar.com', status, mihpayid: 'pu123', ...over2 };
    return sha512hex(responseHashString({ ...f, salt: SALT })).then((hash) => new URLSearchParams({ ...f, hash }).toString());
  };
  return { db, env, sender, Q, call, json, login, start, body, count, payuPost, payuVerifyCalls, handle };
}

describe('flag off and routing', { skip: SKIP }, () => {
  test('unknown paths return null so index.js carries on as before', async () => {
    const t = mk();
    for (const p of ['/api/menu', '/api/prices', '/api/quote', '/api/order', '/', '/api/otp']) assert.equal(await t.call('GET', p), null, p);
  });
  test('ONLINE_ORDER_LIVE off: every customer route answers 503 ordering_closed, config still answers', async () => {
    const t = mk({ ONLINE_ORDER_LIVE: 'false' });
    for (const [m, p, b] of [['GET', '/api/slots?branch=moghalrajpuram'], ['POST', '/api/otp/send', { phone: '9876543210' }], ['POST', '/api/otp/verify', { phone: '9876543210', code: '123456' }], ['POST', '/api/loyalty/lookup', { branch: 'poranki' }], ['POST', '/api/checkout/start', t.body()]]) {
      const r = await t.call(m, p, { body: b });
      assert.equal(r.status, 503, p);
      assert.equal((await t.json(r)).error.code, 'ordering_closed', p);
    }
    const c = await t.json(await t.call('GET', '/api/config'));
    assert.equal(c.orderingOpen, false);
    assert.equal(c.branches.every((b) => b.open === false), true);
    assert.equal(await t.count('orders'), 0);
  });
  test('wrong method gives 405', async () => {
    const t = mk();
    assert.equal((await t.call('GET', '/api/checkout/start')).status, 405);
    assert.equal((await t.call('POST', '/api/config')).status, 405);
  });
  test('missing or short secrets fail closed with provider_down, nothing is written', async () => {
    const t = mk({ TOKEN_SIGNING_KEY: 'short' });
    const r = await t.call('POST', '/api/otp/verify', { body: { phone: '9876543210', code: '123456' } });
    assert.equal((await t.json(r)).error.code, 'provider_down');
    const t2 = mk({ ALLOW_MOCKS: 'false', OTP_PROVIDER: 'mock', TURNSTILE_SECRET: undefined }, { makeSender: undefined });
    const r2 = await t2.call('POST', '/api/otp/send', { body: { phone: '9876543210' } });
    assert.equal(r2.status, 503); // no Turnstile and mocks not allowed: closed
  });
});

describe('config, slots, CORS', { skip: SKIP }, () => {
  test('config lists only live branches as open, with pay-at-pickup only where allowed; Patamatalanka never appears', async () => {
    const t = mk();
    const c = await t.json(await t.call('GET', '/api/config'));
    const by = Object.fromEntries(c.branches.map((b) => [b.code, b]));
    assert.deepEqual([by.moghalrajpuram.open, by.moghalrajpuram.codAllowed, by.poranki.open, by.poranki.codAllowed, by.singhnagar.open], [true, true, true, false, false]);
    assert.equal(c.termsVersion, 'v1'); assert.equal(c.codMaxPaise, 100000);
    assert.equal(Object.keys(by).some((k) => k.includes('patamata')), false);
  });
  test('slots: half-hour windows (owner, 27 Oct): first is now plus 30 minutes, then every 30 minutes until the last window ends at closing; closed branch gives branch_closed; bad branch gives bad_request', async () => {
    const t = mk();
    const s = await t.json(await t.call('GET', '/api/slots?branch=moghalrajpuram'));
    assert.equal(s.slots[0].id, SLOT); assert.equal(s.slots[0].label, '3:00 pm');
    const steps = new Set(s.slots.slice(1).map((x, i) => (Date.parse(x.id) - Date.parse(s.slots[i].id)) / 60000));
    assert.deepEqual([...steps], [30]);
    assert.ok(s.slots.every((x) => /:(00|30) [ap]m$/.test(x.label)));
    assert.equal(s.slots.at(-1).label, '11:00 pm');   // 11:00 to 11:30 pm, closing 23:30
    assert.equal(s.slots.length, 17);
    assert.equal((await t.json(await t.call('GET', '/api/slots?branch=singhnagar'))).error.code, 'branch_closed');
    assert.equal((await t.call('GET', '/api/slots?branch=nowhere')).status, 400);
  });
  test('CORS: allowed origin gets Authorization and Idempotency-Key allowed; other origin gets nothing', async () => {
    const t = mk();
    const ok = await t.call('OPTIONS', '/api/checkout/start', { headers: { Origin: 'https://site.example' } });
    assert.equal(ok.status, 204);
    assert.match(ok.headers.get('Access-Control-Allow-Headers'), /Authorization.*Idempotency-Key/);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://site.example');
    const bad = await t.call('OPTIONS', '/api/checkout/start', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
  });
});

describe('otp routes', { skip: SKIP }, () => {
  test('send: bad phone 400; fourth send in 10 minutes is 429 with retry time; code is never in the response', async () => {
    const t = mk();
    assert.equal((await t.call('POST', '/api/otp/send', { body: { phone: '12345' } })).status, 400);
    for (let i = 0; i < 3; i++) { const r = await t.call('POST', '/api/otp/send', { body: { phone: '9876543210' } }); assert.equal(r.status, 200); assert.doesNotMatch(await r.text(), /\d{6}/); }
    const r4 = await t.call('POST', '/api/otp/send', { body: { phone: '9876543210' } });
    assert.equal(r4.status, 429);
    const e = (await t.json(r4)).error;
    assert.equal(e.code, 'rate_limited'); assert.ok(e.retryAfterSeconds > 0); assert.ok(r4.headers.get('Retry-After'));
  });
  test('turnstile: required token, bad token refused, good token passes', async () => {
    const t = mk({}, { verifyTurnstile: async (env, tok) => tok === 'good' });
    assert.equal((await t.call('POST', '/api/otp/send', { body: { phone: '9876543210' } })).status, 400);
    assert.equal((await t.call('POST', '/api/otp/send', { body: { phone: '9876543210', turnstileToken: 'bad' } })).status, 400);
    assert.equal(t.sender.sent.length, 0);
    assert.equal((await t.call('POST', '/api/otp/send', { body: { phone: '9876543210', turnstileToken: 'good' } })).status, 200);
  });
  test('sender down gives provider_down and the code cannot be used', async () => {
    const t = mk({}, { makeSender: () => ({ async send() { throw new Error('x'); } }) });
    const r = await t.call('POST', '/api/otp/send', { body: { phone: '9876543210' } });
    assert.deepEqual([r.status, (await t.json(r)).error.code], [503, 'provider_down']);
  });
  test('verify: wrong code says tries left, five wrong locks, right code gives a signed token bound to the phone', async () => {
    const t = mk();
    await t.call('POST', '/api/otp/send', { body: { phone: '9876543210' } });
    const code = t.sender.sent.at(-1).code; const wrong = code === '000000' ? '111111' : '000000';
    const w = await t.json(await t.call('POST', '/api/otp/verify', { body: { phone: '9876543210', code: wrong } }));
    assert.equal(w.error.code, 'otp_wrong'); assert.match(w.error.message, /4 tries left/);
    for (let i = 0; i < 3; i++) await t.call('POST', '/api/otp/verify', { body: { phone: '9876543210', code: wrong } });
    await t.call('POST', '/api/otp/verify', { body: { phone: '9876543210', code: wrong } });
    const locked = await t.call('POST', '/api/otp/verify', { body: { phone: '9876543210', code } });
    assert.deepEqual([locked.status, (await t.json(locked)).error.code], [429, 'otp_locked']);
    const t2 = mk(); const tok = await t2.login('9123456780');
    const v = await verifyToken(KEYS.TOKEN_SIGNING_KEY, tok, NOW.getTime());
    assert.deepEqual([v.ok, v.phone], [true, '9123456780']);
  });
});

describe('checkout/start', { skip: SKIP }, () => {
  test('payu: order created PAYMENT_PENDING, PayU form fields built on the server, salt never in the response, status readable with the token only', async () => {
    const t = mk(); const tok = await t.login();
    const r = await t.start(tok); const text = await r.text(); const j = JSON.parse(text);
    assert.equal(r.status, 200);
    assert.deepEqual([j.state, j.totalPaise, j.payment.type, j.payment.method, j.payment.action], ['PAYMENT_PENDING', 63000, 'payu', 'POST', 'https://test.payu.in/_payment']);
    assert.equal(j.payment.fields.amount, '630.00'); assert.equal(j.payment.fields.txnid, j.orderId); assert.match(j.payment.fields.hash, /^[0-9a-f]{128}$/);
    assert.ok(j.payment.fields.surl.startsWith('https://api.example/api/payu/callback?t='));
    assert.equal(text.includes(SALT), false);
    assert.deepEqual([await t.count('orders'), await t.count('order_items'), await t.count('consents'), await t.count('payments')], [1, 1, 2, 1]);
    const st = await t.json(await t.call('GET', `/api/order/status?id=${j.orderId}&t=${j.statusToken}`));
    assert.deepEqual([st.state, st.totalPaise, st.branchName, st.slotLabel, st.method], ['PAYMENT_PENDING', 63000, 'Moghalrajpuram', '3:00 pm', 'payu']);
    assert.deepEqual(Object.keys(st).sort(), ['branch', 'branchName', 'earnPoints', 'method', 'orderId', 'slotLabel', 'state', 'totalPaise']); // no phone, customer name or email
    assert.equal((await t.call('GET', `/api/order/status?id=${j.orderId}&t=wrong`)).status, 404);
    assert.equal((await t.call('GET', `/api/order/status?id=RR-0000000000&t=${j.statusToken}`)).status, 404);
  });
  test('needs a valid Bearer token and an Idempotency-Key', async () => {
    const t = mk(); const tok = await t.login();
    assert.equal((await t.call('POST', '/api/checkout/start', { body: t.body(), headers: { 'Idempotency-Key': 'idem-0000-abcdefghijkl' } })).status, 401);
    assert.equal((await t.call('POST', '/api/checkout/start', { body: t.body(), headers: { Authorization: 'Bearer abc.def', 'Idempotency-Key': 'idem-0000-abcdefghijkl' } })).status, 401);
    const noKey = await t.call('POST', '/api/checkout/start', { body: t.body(), headers: { Authorization: `Bearer ${tok}` } });
    assert.equal((await t.json(noKey)).error.field, 'Idempotency-Key');
    assert.equal(await t.count('orders'), 0);
  });
  test('same key and same body replays the first answer (one order); same key with another body is idempotency_conflict', async () => {
    const t = mk(); const tok = await t.login();
    const a = await t.json(await t.start(tok, t.body(), 'same-key-0000-abcdef'));
    const b = await t.json(await t.start(tok, t.body(), 'same-key-0000-abcdef'));
    assert.deepEqual(b, a); assert.equal(await t.count('orders'), 1);
    const c = await t.start(tok, t.body({ items: [{ id: 'r1', qty: 3 }] }), 'same-key-0000-abcdef');
    assert.deepEqual([c.status, (await t.json(c)).error.code], [409, 'idempotency_conflict']);
    assert.equal(await t.count('orders'), 1);
  });
  test('a retryable failure frees the key and keeps the token: the page can retry the same attempt', async () => {
    const t = mk(); const tok = await t.login();
    t.Q.fail = 'provider_down';
    const r1 = await t.start(tok, t.body(), 'retry-key-0000-abcde');
    assert.deepEqual([r1.status, (await t.json(r1)).error.code], [503, 'provider_down']);
    t.Q.fail = null;
    const r2 = await t.start(tok, t.body(), 'retry-key-0000-abcde');
    assert.equal(r2.status, 200); assert.equal(await t.count('orders'), 1);
  });
  test('sold-out item gives item_unavailable with the item id; token and key are kept', async () => {
    const t = mk(); const tok = await t.login(); t.Q.fail = 'item_unavailable';
    const r = await t.start(tok, t.body(), 'soldout-key-000-abcde');
    const e = (await t.json(r)).error; assert.deepEqual([r.status, e.code, e.field], [409, 'item_unavailable', 'r1']);
    t.Q.fail = null; assert.equal((await t.start(tok, t.body(), 'soldout-key-000-abcde')).status, 200);
  });
  test('the token is good for ONE order: a second order with the same token is refused', async () => {
    const t = mk(); const tok = await t.login();
    assert.equal((await t.start(tok)).status, 200);
    const r = await t.start(tok);
    assert.deepEqual([r.status, (await t.json(r)).error.code], [401, 'token_invalid']);
    assert.equal(await t.count('orders'), 1);
  });
  test('pay at pickup: exactly Rs 1000.00 allowed at an allowed outlet (state CREATED, no payment row); Rs 1000.01 refused, nothing written, token not burnt', async () => {
    const t = mk(); const tok = await t.login();
    t.Q.unit = 100001; t.Q.taxPct = 0; // total 100001 paise
    const no = await t.start(tok, t.body({ method: 'cod', items: [{ id: 'r1', qty: 1 }] }));
    assert.deepEqual([no.status, (await t.json(no)).error.code], [400, 'cod_not_allowed']);
    assert.equal(await t.count('orders'), 0);
    t.Q.unit = 100000;
    const yes = await t.json(await t.start(tok, t.body({ method: 'cod', items: [{ id: 'r1', qty: 1 }] })));
    assert.deepEqual([yes.state, yes.totalPaise, yes.payment, await t.count('payments')], ['CREATED', 100000, null, 0]);
  });
  test('pay at pickup refused where the outlet does not allow it, and when COD_LIVE is off; payu still works', async () => {
    const t = mk(); const tok = await t.login();
    const a = await t.start(tok, t.body({ branch: 'poranki', method: 'cod' }));
    assert.equal((await t.json(a)).error.code, 'cod_not_allowed');
    const t2 = mk({ COD_LIVE: 'false' }); const tok2 = await t2.login();
    assert.equal((await t2.json(await t2.start(tok2, t2.body({ method: 'cod' })))).error.code, 'cod_not_allowed');
    assert.equal((await t2.start(tok2, t2.body({ method: 'payu' }))).status, 200);
  });
  test('open-order cap: a third open order for one phone is refused with 429 and the token is kept', async () => {
    const t = mk();
    for (let i = 0; i < 2; i++) assert.equal((await t.start(await t.login('9000000001'), t.body({ method: 'cod' }))).status, 200);
    const tok3 = await t.login('9000000001');
    const r = await t.start(tok3, t.body({ method: 'cod' }));
    assert.deepEqual([r.status, (await t.json(r)).error.code], [429, 'too_many_open_orders']);
    assert.equal(await t.count('orders'), 2);
    assert.equal((await t.start(tok3, t.body({ method: 'payu' }))).status, 429); // still capped, not a token problem
  });
  test('expectedTotalPaise that differs from the server total gives quote_mismatch with the new total and burns nothing', async () => {
    const t = mk(); const tok = await t.login();
    const r = await t.start(tok, t.body({ expectedTotalPaise: 1 }));
    const e = (await t.json(r)).error; assert.deepEqual([r.status, e.code, e.details.totalPaise], [409, 'quote_mismatch', 63000]);
    assert.equal((await t.start(tok, t.body({ expectedTotalPaise: 63000 }))).status, 200);
  });
  test('slot not on the list is slot_invalid; closed branch is branch_closed', async () => {
    const t = mk(); const tok = await t.login();
    assert.equal((await t.json(await t.start(tok, t.body({ slotId: '2026-10-24T09:31:00.000Z' })))).error.code, 'slot_invalid');
    assert.equal((await t.json(await t.start(tok, t.body({ branch: 'singhnagar' })))).error.code, 'branch_closed');
    assert.equal(await t.count('orders'), 0);
  });
  test('consent: terms must be true, version must match, bad items and bad email are refused', async () => {
    const t = mk(); const tok = await t.login();
    const code = async (b) => (await t.json(await t.start(tok, b))).error;
    assert.equal((await code(t.body({ consent: { terms: false, marketing: false, version: 'v1' } }))).field, 'consent.terms');
    assert.equal((await code(t.body({ consent: { terms: true, marketing: false, version: 'old' } }))).field, 'consent.version');
    assert.equal((await code(t.body({ items: [{ id: 'r1', qty: 0 }] }))).field, 'items');
    assert.equal((await code(t.body({ items: [{ id: 'r1', qty: 1 }, { id: 'r1', qty: 1 }] }))).field, 'items');
    assert.equal((await code(t.body({ customer: { name: 'A', email: 'not-an-email' } }))).field, 'customer.email');
    assert.equal(await t.count('orders'), 0);
  });
  test('the sixth placement in 10 minutes by one phone is rate_limited', async () => {
    const t = mk(); const tok = await t.login('9111111111'); let last; t.Q.fail = 'item_unavailable'; // failures keep the token, so one token can try again and again
    for (let i = 0; i < 6; i++) last = await t.start(tok, t.body(), `rl-key-${i}-0000000000000`);
    const e = (await t.json(last)).error; assert.deepEqual([last.status, e.code], [429, 'rate_limited']); assert.ok(e.retryAfterSeconds > 0);
  });
  test('loyalty: Reelo down or not wired is available:false, never an error; needs a token', async () => {
    const t = mk(); const tok = await t.login();
    assert.equal((await t.call('POST', '/api/loyalty/lookup', { body: { branch: 'poranki' } })).status, 401);
    const r = await t.call('POST', '/api/loyalty/lookup', { body: { branch: 'poranki' }, headers: { Authorization: `Bearer ${tok}` } });
    assert.deepEqual(await t.json(r), { available: false });
    const t2 = mk({}, { loyaltyLookup: async () => { throw new Error('down'); } }); const tk2 = await t2.login();
    assert.deepEqual(await t2.json(await t2.call('POST', '/api/loyalty/lookup', { body: { branch: 'poranki' }, headers: { Authorization: `Bearer ${tk2}` } })), { available: false });
    const t3 = mk({}, { loyaltyLookup: async () => ({ available: true, member: null, balance: 240, earnPoints: 600, rewardsCount: 3 }) }); const tk3 = await t3.login();
    assert.deepEqual(await t3.json(await t3.call('POST', '/api/loyalty/lookup', { body: { branch: 'poranki' }, headers: { Authorization: `Bearer ${tk3}` } })), { available: true, member: null, balance: 240, earnPoints: 600, rewardsCount: 3 });
  });
});

describe('PayU callback and webhook', { skip: SKIP }, () => {
  const place = async (t) => { const tok = await t.login(); return t.json(await t.start(tok)); };
  const state = async (t, id) => (await t.db.prepare('SELECT state FROM orders WHERE id = ?').bind(id).first()).state;
  test('good callback + PayU confirms: order PAID once, customer sent back with 303; a repeat changes nothing; webhook after callback is a no-op 200', async () => {
    const t = mk(); const o = await place(t); t.Q.verify = () => ({ status: 'success', amountPaise: o.totalPaise, payuRef: 'pu123' });
    const raw = await t.payuPost(o);
    const r = await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw });
    assert.equal(r.status, 303); assert.equal(r.headers.get('Location'), `https://site.example/checkout/?order=${o.orderId}&t=${o.statusToken}`);
    assert.equal(await state(t, o.orderId), 'PAID');
    const again = await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw });
    assert.equal(again.status, 303); assert.equal(await state(t, o.orderId), 'PAID');
    const w = await t.call('POST', '/api/payu/webhook', { raw });
    assert.equal(w.status, 200); assert.equal(await state(t, o.orderId), 'PAID');
    assert.equal((await t.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'SUCCESS'").first()).n, 1);
  });
  test('webhook first, then callback: still exactly one PAID', async () => {
    const t = mk(); const o = await place(t); t.Q.verify = () => ({ status: 'success', amountPaise: o.totalPaise });
    const raw = await t.payuPost(o);
    assert.equal((await t.call('POST', '/api/payu/webhook', { raw })).status, 200);
    assert.equal((await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw })).status, 303);
    assert.equal(await state(t, o.orderId), 'PAID');
  });
  test('wrong hash: order stays PAYMENT_PENDING and PayU is not even asked', async () => {
    const t = mk(); const o = await place(t); t.Q.verify = () => ({ status: 'success', amountPaise: o.totalPaise });
    const raw = (await t.payuPost(o)).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(128));
    await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw });
    assert.equal(await state(t, o.orderId), 'PAYMENT_PENDING'); assert.equal(t.payuVerifyCalls.length, 0);
  });
  test('good hash but PayU server says not paid, or cannot be asked: never PAID', async () => {
    const t = mk(); const o = await place(t); const raw = await t.payuPost(o);
    await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw }); // payuVerify returns null
    assert.equal(await state(t, o.orderId), 'PAYMENT_PENDING');
    t.Q.verify = () => ({ status: 'failure', amountPaise: o.totalPaise });
    await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw });
    assert.equal(await state(t, o.orderId), 'PAYMENT_PENDING');
    const t2 = mk({}, { payuVerify: undefined }); const o2 = await place(t2);
    await t2.call('POST', `/api/payu/callback?t=${o2.statusToken}`, { raw: await t2.payuPost(o2) });
    assert.equal(await state(t2, o2.orderId), 'PAYMENT_PENDING');
  });
  test('amount that differs from the order total: never PAID, payment recorded as MISMATCH', async () => {
    const t = mk(); const o = await place(t); t.Q.verify = () => ({ status: 'success', amountPaise: o.totalPaise });
    const raw = await t.payuPost(o, 'success', { amount: '1.00' });
    await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw });
    assert.equal(await state(t, o.orderId), 'PAYMENT_PENDING');
    assert.equal((await t.db.prepare('SELECT status FROM payments').first()).status, 'MISMATCH');
    t.Q.verify = () => ({ status: 'success', amountPaise: 100 }); // PayU server disagrees with the order too
    const raw2 = await t.payuPost(o);
    await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw: raw2 });
    assert.notEqual(await state(t, o.orderId), 'PAID');
  });
  test('failure or cancel from PayU: PAYMENT_FAILED; a later success on that order goes to REFUND_NEEDED, never PAID', async () => {
    const t = mk(); const o = await place(t);
    await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw: await t.payuPost(o, 'failure') });
    assert.equal(await state(t, o.orderId), 'PAYMENT_FAILED');
    t.Q.verify = () => ({ status: 'success', amountPaise: o.totalPaise });
    await t.call('POST', `/api/payu/callback?t=${o.statusToken}`, { raw: await t.payuPost(o) });
    assert.equal(await state(t, o.orderId), 'REFUND_NEEDED');
  });
  test('the callback works even when ordering is switched off (money may already be taken); a wrong status token does not leak the token back', async () => {
    const t = mk({ ONLINE_ORDER_LIVE: 'false' }); t.env.ONLINE_ORDER_LIVE = 'true'; const o = await place(t); t.env.ONLINE_ORDER_LIVE = 'false';
    t.Q.verify = () => ({ status: 'success', amountPaise: o.totalPaise });
    const bad = await t.call('POST', '/api/payu/callback?t=wrongtoken', { raw: await t.payuPost(o) });
    assert.equal(bad.headers.get('Location'), 'https://site.example/checkout/');
    assert.equal(await state(t, o.orderId), 'PAID');
  });
  test('unknown txnid is handled quietly (303 to the checkout page, webhook 200)', async () => {
    const t = mk();
    const raw = new URLSearchParams({ txnid: 'RR-9999999999', status: 'success', hash: 'x' }).toString();
    assert.equal((await t.call('POST', '/api/payu/callback', { raw })).status, 303);
    assert.equal((await t.call('POST', '/api/payu/webhook', { raw })).status, 200);
  });
});

describe('mock payment (staging only)', { skip: SKIP }, () => {
  test('PAYMENT_PROVIDER=mock with ALLOW_MOCKS: /api/mock/pay marks PAID with the right token only; without the flags it is 404 and checkout refuses', async () => {
    const t = mk({ PAYMENT_PROVIDER: 'mock', PAYU_KEY: undefined, PAYU_SALT: undefined, API_ORIGIN: 'https://api.example' });
    const o = await t.json(await t.start(await t.login()));
    assert.equal(o.payment.fields.key, 'mock');
    assert.equal((await t.call('POST', '/api/mock/pay', { body: { orderId: o.orderId, t: 'bad', ok: true } })).status, 404);
    assert.equal((await t.json(await t.call('POST', '/api/mock/pay', { body: { orderId: o.orderId, t: o.statusToken, ok: true } }))).state, 'PAID');
    // Mocks switched off (production): the mock pay route is gone and checkout refuses a mock payment provider.
    const prod = mk({ PAYMENT_PROVIDER: 'mock' }); const tok = await prod.login(); prod.env.ALLOW_MOCKS = 'false';
    assert.equal((await prod.call('POST', '/api/mock/pay', { body: { orderId: 'x', t: 'y', ok: true } })).status, 404);
    const r = await prod.start(tok);
    assert.deepEqual([r.status, (await prod.json(r)).error.code, await prod.count('orders')], [503, 'provider_down', 0]);
  });
});
