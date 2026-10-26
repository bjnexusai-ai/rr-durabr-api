// node --test test/rr-reconcile.test.mjs   (task 8.5, PayU half; real migrations through testlib/d1shim.mjs; PayU is faked)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, SKIP } from './_db.mjs';
import { createOrder, newStatusToken } from '../src/orderstore.js';
import { transition, markPaid } from '../src/orderstate.js';
import { reconcilePayu } from '../src/reconcile.js';

const NOW = new Date();
const ago = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
let n = 0;
async function order(db, { hoursOld = 5, method = 'payu' } = {}) {
  const t = await newStatusToken(); n++;
  const r = await createOrder(db, { branch: 'moghalrajpuram', slotAt: ago(-1), method, items: [{ ristaItemId: 'r1', name: 'Biryani', qty: 2, unitPaise: 30000 }],
    subtotalPaise: 60000, taxPaise: 3000, totalPaise: 63000, phone: `98765432${String(n).padStart(2, '0')}`, name: 'Asha', statusTokenHash: t.hash,
    consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }], maxOpen: 99, codMaxPaise: 100000, codAllowedForBranch: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  await db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').bind(ago(hoursOld), r.orderId).run();
  return r.orderId;
}
const paid = async (db, id) => assert.equal((await markPaid(db, { orderId: id, txnid: id, payuRef: 'p', amountPaise: 63000, actor: 'payu_callback' })).ok, true);
const state = async (db, id) => (await db.prepare('SELECT state FROM orders WHERE id = ?').bind(id).first()).state;

describe('daily PayU check (8.5) on the real migrations', { skip: SKIP }, () => {
  test('matching orders are quiet: no alert', async () => {
    const db = makeD1(); const a = await order(db); await paid(db, a);
    const f = await order(db); await transition(db, { orderId: f, from: 'PAYMENT_PENDING', to: 'PAYMENT_FAILED', actor: 'api' });
    const alerts = [];
    const r = await reconcilePayu(db, {}, { now: NOW, alert: async (t) => alerts.push(t),
      payuVerify: async (env, id) => (id === a ? { status: 'success', amountPaise: 63000 } : { status: 'failure' }) });
    assert.equal(r.checked, 2); assert.equal(r.ok, 2); assert.equal(alerts.length, 0);
  });
  test('paid with us but not at PayU, or a different amount: one alert naming both orders', async () => {
    const db = makeD1(); const a = await order(db); await paid(db, a); const b = await order(db); await paid(db, b);
    const alerts = [];
    const r = await reconcilePayu(db, {}, { now: NOW, alert: async (t) => alerts.push(t),
      payuVerify: async (env, id) => (id === a ? { status: 'failure' } : { status: 'success', amountPaise: 60000 }) });
    assert.equal(r.problems.length, 2); assert.equal(alerts.length, 1);
    assert.match(alerts[0], new RegExp(`${a}: paid in our records`)); assert.match(alerts[0], new RegExp(`${b}: PayU amount Rs 600.00, our record Rs 630.00`));
    assert.equal(await state(db, a), 'PAID', 'the check reports; it never changes a paid order by itself');
  });
  test('money taken after the order was closed: REFUND_NEEDED and an alert', async () => {
    const db = makeD1(); const e = await order(db); await transition(db, { orderId: e, from: 'PAYMENT_PENDING', to: 'EXPIRED', actor: 'cron' });
    const alerts = [];
    const r = await reconcilePayu(db, {}, { now: NOW, alert: async (t) => alerts.push(t), payuVerify: async () => ({ status: 'success', amountPaise: 63000, payuRef: 'late' }) });
    assert.equal(await state(db, e), 'REFUND_NEEDED'); assert.equal(r.refundNeeded.length, 1); assert.match(alerts[0], /Refund it in PayU/);
  });
  test('an old open refund is reminded; waiting, old and pay-at-pickup orders are skipped; PayU down = unchecked, no alert', async () => {
    const db = makeD1();
    const rf = await order(db); await transition(db, { orderId: rf, from: 'PAYMENT_PENDING', to: 'EXPIRED', actor: 'cron' });
    await transition(db, { orderId: rf, from: 'EXPIRED', to: 'REFUND_NEEDED', actor: 'cron' });
    await db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').bind(ago(30), rf).run();
    await order(db);                       // still waiting: expireUnpaid's job
    const old = await order(db, { hoursOld: 72 }); await paid(db, old);
    await order(db, { method: 'cod' });
    const down = await order(db); await paid(db, down);
    const asked = [], alerts = [];
    const r = await reconcilePayu(db, {}, { now: NOW, alert: async (t) => alerts.push(t), payuVerify: async (env, id) => { asked.push(id); throw new Error('payu down'); } });
    assert.deepEqual(asked, [down]); assert.equal(r.unchecked, 1); assert.deepEqual(r.openRefunds, [rf]);
    assert.equal(alerts.length, 1); assert.match(alerts[0], /refund still open after 24 hours/);
  });
});
