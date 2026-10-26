// node --test test/rr-ristapush.test.mjs   (real migrations through testlib/d1shim.mjs; Rista is faked)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, SKIP } from './_db.mjs';
import { createOrder, newStatusToken } from '../src/orderstore.js';
import { markPaid } from '../src/orderstate.js';
import { makeRistaPusher, MAX_TRIES } from '../src/ristapush.js';

async function order(db, method = 'payu', phone = '9876543210') {
  const t = await newStatusToken();
  const r = await createOrder(db, { branch: 'moghalrajpuram', slotAt: new Date(Date.now() + 3600e3).toISOString(), method, items: [{ ristaItemId: 'r1', name: 'Chicken Dum Biryani', qty: 2, unitPaise: 30000 }],
    subtotalPaise: 60000, taxPaise: 3000, totalPaise: 63000, phone, name: 'Asha', statusTokenHash: t.hash, consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }], maxOpen: 99, codMaxPaise: 100000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (method === 'payu') assert.equal((await markPaid(db, { orderId: r.orderId, txnid: r.orderId, payuRef: 'p', amountPaise: 63000, actor: 'payu_callback' })).ok, true);
  return r.orderId;
}
const state = async (db, id) => (await db.prepare('SELECT state FROM orders WHERE id = ?').bind(id).first()).state;
const pushes = async (db, id) => (await db.prepare('SELECT attempt, status FROM rista_pushes WHERE order_id = ? ORDER BY attempt').bind(id).all()).results.map((r) => `${r.attempt}:${r.status}`);
const ago = (db, id, min) => db.prepare('UPDATE rista_pushes SET at = ? WHERE order_id = ?').bind(new Date(Date.now() - min * 60000).toISOString(), id).run();

describe('Rista push and retries (8.2 to 8.4, 8.7) on the real migrations', { skip: SKIP }, () => {
  test('paid online order: Rista gets one sale with the right content; order becomes CONFIRMED', async () => {
    const db = makeD1(); const id = await order(db); const sent = [];
    const p = makeRistaPusher({ sendSale: async (env, sale) => { sent.push(sale); return { ok: true, invoice: 'INV-77' }; } });
    assert.deepEqual(await p.pushToRista({ DB: db }, { orderId: id, method: 'payu' }), { ok: true, attempt: 1 });
    assert.equal(await state(db, id), 'CONFIRMED');
    assert.equal(sent.length, 1);
    const s = sent[0];
    assert.equal(s.reference, id); assert.equal(s.branchCode, 'MR'); assert.equal(s.paid, true); assert.equal(s.totalPaise, 63000);
    assert.deepEqual(s.items, [{ ristaItemId: 'r1', name: 'Chicken Dum Biryani', qty: 2, unitPaise: 30000, linePaise: 60000 }]);
    assert.equal(s.customer.phone, '9876543210'); assert.match(s.note, /paid online \(PayU\)/);
    assert.deepEqual(await pushes(db, id), ['1:OK']);
  });

  test('pay-at-pickup order goes as unpaid and becomes CONFIRMED', async () => {
    const db = makeD1(); const id = await order(db, 'cod'); let sale;
    await makeRistaPusher({ sendSale: async (e, s) => { sale = s; return { ok: true }; } }).pushToRista({ DB: db }, { orderId: id });
    assert.equal(sale.paid, false); assert.match(sale.note, /pay at pickup/); assert.equal(await state(db, id), 'CONFIRMED');
  });

  test('an unpaid online order is NEVER sent to Rista', async () => {
    const db = makeD1(); const t = await newStatusToken(); let sent = 0;
    const r = await createOrder(db, { branch: 'moghalrajpuram', slotAt: new Date(Date.now() + 3600e3).toISOString(), method: 'payu', items: [{ ristaItemId: 'r1', name: 'X', qty: 1, unitPaise: 10000 }], subtotalPaise: 10000, taxPaise: 500, totalPaise: 10500, phone: '9876543210', statusTokenHash: t.hash, consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }] });
    const res = await makeRistaPusher({ sendSale: async () => { sent++; return { ok: true }; } }).pushToRista({ DB: db }, { orderId: r.orderId });
    assert.equal(res.code, 'not_pushable'); assert.equal(sent, 0); assert.equal(await state(db, r.orderId), 'PAYMENT_PENDING');
  });

  test('Rista down: PUSH_FAILED, retried on the 1, 2, 5, 10 minute schedule, then REFUND_NEEDED and one owner alert', async () => {
    const db = makeD1(); const id = await order(db); const alerts = []; let calls = 0;
    const p = makeRistaPusher({ sendSale: async () => { calls++; return { ok: false, httpCode: 503 }; }, alert: async (e, a) => alerts.push(a) });
    await p.pushToRista({ DB: db }, { orderId: id });
    assert.equal(await state(db, id), 'PUSH_FAILED');
    assert.equal((await p.retryPushes({ DB: db })).tried, 0, 'not due yet');
    for (const min of [1, 2, 5, 10]) { await ago(db, id, min + 0.1); assert.equal((await p.retryPushes({ DB: db })).tried, 1, `retry after ${min} min`); }
    assert.equal(calls, MAX_TRIES);
    assert.equal(await state(db, id), 'REFUND_NEEDED');
    assert.equal(alerts.length, 1); assert.equal(alerts[0].type, 'refund_needed');
    await ago(db, id, 60); assert.equal((await p.retryPushes({ DB: db })).tried, 0, 'no more tries after the limit');
  });

  test('Rista comes back on the second try: CONFIRMED, no alert', async () => {
    const db = makeD1(); const id = await order(db); const alerts = []; let n = 0;
    const p = makeRistaPusher({ sendSale: async () => (++n === 1 ? { ok: false, httpCode: 500 } : { ok: true }), alert: async (e, a) => alerts.push(a) });
    await p.pushToRista({ DB: db }, { orderId: id }); await ago(db, id, 2); await p.retryPushes({ DB: db });
    assert.equal(await state(db, id), 'CONFIRMED'); assert.deepEqual(await pushes(db, id), ['1:FAILED', '2:OK']); assert.equal(alerts.length, 0);
  });

  test('pay-at-pickup that never reaches Rista stays PUSH_FAILED (nothing to refund) with a call-the-customer alert', async () => {
    const db = makeD1(); const id = await order(db, 'cod'); const alerts = [];
    const p = makeRistaPusher({ sendSale: async () => { throw new Error('down'); }, alert: async (e, a) => alerts.push(a) });
    await p.pushToRista({ DB: db }, { orderId: id });
    for (let i = 0; i < 4; i++) { await ago(db, id, 11); await p.retryPushes({ DB: db }); }
    assert.equal(await state(db, id), 'PUSH_FAILED'); assert.equal(alerts.length, 1); assert.equal(alerts[0].type, 'push_failed');
  });

  test('two runs at the same moment send the same try only once', async () => {
    const db = makeD1(); const id = await order(db); let sent = 0; let release;
    const gate = new Promise((r) => { release = r; });
    const p = makeRistaPusher({ sendSale: async () => { sent++; await gate; return { ok: true }; } });
    const a = p.pushToRista({ DB: db }, { orderId: id }); const b = p.pushToRista({ DB: db }, { orderId: id });
    const rb = await b; release(); await a;
    assert.equal(rb.code, 'busy'); assert.equal(sent, 1); assert.equal(await state(db, id), 'CONFIRMED');
  });

  test('a first try that never ran (lost background task) is picked up by the scheduled job after 2 minutes', async () => {
    const db = makeD1(); const id = await order(db); let sent = 0;
    const p = makeRistaPusher({ sendSale: async () => { sent++; return { ok: true }; } });
    assert.equal((await p.retryPushes({ DB: db })).tried, 0, 'too fresh');
    assert.equal((await p.retryPushes({ DB: db }, { now: new Date(Date.now() + 3 * 60000) })).tried, 1);
    assert.equal(sent, 1); assert.equal(await state(db, id), 'CONFIRMED');
  });
});
