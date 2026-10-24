import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, SKIP } from './_db.mjs';
import { createOrder, newStatusToken, newOrderId, getOrderStatus, beginIdempotent, finishIdempotent, sha256hex } from '../src/orderstore.js';
import { transition } from '../src/orderstate.js';

const mk = async (over = {}) => {
  const t = await newStatusToken();
  return { t, o: { branch: 'moghalrajpuram', slotAt: '2026-10-24T08:00:00.000Z', method: 'payu', items: [{ ristaItemId: 'r1', name: 'Biryani', qty: 2, unitPaise: 30000 }], subtotalPaise: 60000, taxPaise: 3000, totalPaise: 63000, phone: '9876543210', name: 'Asha', statusTokenHash: t.hash, earnPoints: 630, consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }, { kind: 'marketing', granted: false, wordingVersion: 'v1' }], ...over } };
};
const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

test('order id shape: RR- plus 11 digits, IST date', () => {
  const id = newOrderId(new Date('2026-10-24T19:00:00Z')); // already 25 Oct in IST
  assert.match(id, /^RR-261025\d{5}$/);
});
test('status token is 32 hex chars and its hash is sha256', async () => {
  const t = await newStatusToken();
  assert.match(t.token, /^[0-9a-f]{32}$/);
  assert.equal(t.hash, await sha256hex(t.token));
});

describe('createOrder on real SQLite', { skip: SKIP }, () => {
  test('payu order: PAYMENT_PENDING with items, consents, customer and INITIATED payment in one go', async () => {
    const db = makeD1(); const { o } = await mk();
    const r = await createOrder(db, o);
    assert.deepEqual([r.ok, r.state], [true, 'PAYMENT_PENDING']);
    assert.deepEqual([await count(db, 'orders'), await count(db, 'order_items'), await count(db, 'consents'), await count(db, 'customers'), await count(db, 'payments')], [1, 1, 2, 1, 1]);
    const p = await db.prepare('SELECT txnid, status, amount_paise FROM payments').first();
    assert.deepEqual([p.txnid, p.status, p.amount_paise], [r.orderId, 'INITIATED', 63000]);
  });
  test('cod order at exactly Rs 1000.00 is created in state CREATED, no payment row', async () => {
    const db = makeD1(); const { o } = await mk({ method: 'cod', items: [{ ristaItemId: 'r1', name: 'X', qty: 1, unitPaise: 95000 }], subtotalPaise: 95000, taxPaise: 5000, totalPaise: 100000 });
    const r = await createOrder(db, o);
    assert.deepEqual([r.ok, r.state, await count(db, 'payments')], [true, 'CREATED', 0]);
  });
  test('cod above Rs 1000 is refused by the API check and nothing is written', async () => {
    const db = makeD1(); const { o } = await mk({ method: 'cod', items: [{ ristaItemId: 'r1', name: 'X', qty: 1, unitPaise: 95001 }], subtotalPaise: 95001, taxPaise: 5000, totalPaise: 100001 });
    assert.equal((await createOrder(db, o)).code, 'method_not_allowed');
    assert.deepEqual([await count(db, 'orders'), await count(db, 'customers')], [0, 0]);
  });
  test('browser total that does not match items is refused', async () => {
    const db = makeD1(); const { o } = await mk({ subtotalPaise: 100, totalPaise: 3100 });
    assert.equal((await createOrder(db, o)).code, 'totals_mismatch');
  });
  test('terms consent is required; marketing alone is not enough', async () => {
    const db = makeD1();
    assert.equal((await createOrder(db, (await mk({ consents: [] })).o)).code, 'terms_required');
    assert.equal((await createOrder(db, (await mk({ consents: [{ kind: 'marketing', granted: true, wordingVersion: 'v1' }] })).o)).code, 'terms_required');
    assert.equal((await createOrder(db, (await mk({ consents: [{ kind: 'terms', granted: false, wordingVersion: 'v1' }] })).o)).code, 'terms_required');
  });
  test('bad phone, bad qty, empty cart, float money are refused', async () => {
    const db = makeD1();
    assert.equal((await createOrder(db, (await mk({ phone: '1234567890' })).o)).code, 'bad_phone');
    assert.equal((await createOrder(db, (await mk({ items: [{ ristaItemId: 'r', name: 'X', qty: 21, unitPaise: 1 }] })).o)).code, 'bad_items');
    assert.equal((await createOrder(db, (await mk({ items: [] })).o)).code, 'bad_items');
    assert.equal((await createOrder(db, (await mk({ taxPaise: 30.5 })).o)).code, 'totals_mismatch');
  });
  test('open-order cap: third open order for the same phone is refused; a finished order frees a place', async () => {
    const db = makeD1();
    const ids = [];
    for (let i = 0; i < 2; i++) { const r = await createOrder(db, (await mk({ slotAt: new Date(Date.now() + 3600000).toISOString() })).o); assert.equal(r.ok, true); ids.push(r.orderId); }
    assert.equal((await createOrder(db, (await mk({ slotAt: new Date(Date.now() + 3600000).toISOString() })).o)).code, 'too_many_open_orders');
    await transition(db, { orderId: ids[0], from: 'PAYMENT_PENDING', to: 'EXPIRED', actor: 'cron' });
    assert.equal((await createOrder(db, (await mk({ slotAt: new Date(Date.now() + 3600000).toISOString() })).o)).ok, true);
  });
  test('repeat customer is updated, not duplicated; name is kept when a later order has none', async () => {
    const db = makeD1();
    await createOrder(db, (await mk({ name: 'Asha', email: 'a@x.in' })).o);
    await createOrder(db, (await mk({ name: null, email: null, slotAt: '2020-01-01T00:00:00.000Z' })).o);
    assert.equal(await count(db, 'customers'), 1);
    const c = await db.prepare('SELECT name, email FROM customers').first();
    assert.deepEqual([c.name, c.email], ['Asha', 'a@x.in']);
  });
  test('a failing statement rolls the whole order back (no half-created order)', async () => {
    const db = makeD1(); const { o } = await mk({ consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }, { kind: 'bogus', granted: true, wordingVersion: 'v1' }] });
    await assert.rejects(() => createOrder(db, o));
    assert.deepEqual([await count(db, 'orders'), await count(db, 'order_items'), await count(db, 'payments')], [0, 0, 0]);
  });
});

describe('order status needs the secret token', { skip: SKIP }, () => {
  test('right token returns the order without the hash; wrong or missing token returns null', async () => {
    const db = makeD1(); const { t, o } = await mk();
    const { orderId } = await createOrder(db, o);
    const s = await getOrderStatus(db, { id: orderId, t: t.token });
    assert.equal(s.state, 'PAYMENT_PENDING');
    assert.equal('status_token_hash' in s, false);
    assert.equal(await getOrderStatus(db, { id: orderId, t: 'f'.repeat(32) }), null);
    assert.equal(await getOrderStatus(db, { id: orderId }), null);
    assert.equal(await getOrderStatus(db, { id: 'RR-000', t: t.token }), null);
  });
});

describe('idempotency', { skip: SKIP }, () => {
  const K = 'k'.repeat(20);
  test('new, then replay of the stored response, then conflict for a different request', async () => {
    const db = makeD1();
    assert.deepEqual(await beginIdempotent(db, { key: K, phone: '9876543210', requestHash: 'h1' }), { kind: 'new' });
    assert.deepEqual(await beginIdempotent(db, { key: K, phone: '9876543210', requestHash: 'h1' }), { kind: 'in_progress' });
    const { o } = await mk(); const { orderId } = await createOrder(db, o);
    await finishIdempotent(db, { key: K, orderId, response: { orderId } });
    assert.deepEqual(await beginIdempotent(db, { key: K, phone: '9876543210', requestHash: 'h1' }), { kind: 'replay', response: { orderId } });
    assert.deepEqual(await beginIdempotent(db, { key: K, phone: '9876543210', requestHash: 'OTHER' }), { kind: 'conflict' });
    assert.deepEqual(await beginIdempotent(db, { key: K, phone: '9000000000', requestHash: 'h1' }), { kind: 'conflict' });
  });
  test('short key is refused; an expired key can be reused', async () => {
    const db = makeD1();
    assert.deepEqual(await beginIdempotent(db, { key: 'short', phone: '9876543210', requestHash: 'h' }), { kind: 'bad_key' });
    await beginIdempotent(db, { key: K, phone: '9876543210', requestHash: 'h1', now: new Date('2026-01-01T00:00:00Z'), ttlSec: 60 });
    assert.deepEqual(await beginIdempotent(db, { key: K, phone: '9876543210', requestHash: 'h2', now: new Date('2026-01-02T00:00:00Z') }), { kind: 'new' });
  });
});
