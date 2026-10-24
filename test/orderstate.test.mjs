import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeD1, SKIP } from './_db.mjs';
import { createOrder, newStatusToken } from '../src/orderstore.js';
import { transition, markPaid, canTransition, TRANSITIONS } from '../src/orderstate.js';

const base = async (db, over = {}) => {
  const { hash } = await newStatusToken();
  const r = await createOrder(db, { branch: 'moghalrajpuram', slotAt: '2026-10-24T08:00:00.000Z', method: 'payu', items: [{ ristaItemId: 'r1', name: 'Biryani', qty: 2, unitPaise: 30000 }], subtotalPaise: 60000, taxPaise: 3000, totalPaise: 63000, phone: '9876543210', statusTokenHash: hash, consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }], ...over });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.orderId;
};
const state = async (db, id) => (await db.prepare('SELECT state, version FROM orders WHERE id = ?').bind(id).first());
const events = async (db, id) => (await db.prepare('SELECT from_state, to_state, actor FROM events WHERE order_id = ? ORDER BY id').bind(id).all()).results;

describe('state machine on a real SQLite with the real migrations', { skip: SKIP }, () => {
  test('table in code matches the trigger: every code-legal move works, every other move is blocked by the database', async () => {
    const guardSql = readFileSync(new URL('../migrations/0002_guards.sql', import.meta.url), 'utf8').match(/CREATE TRIGGER trg_orders_state_guard[\s\S]*?END;/)[0];
    const all = Object.keys(TRANSITIONS);
    let checked = 0;
    for (const from of all) for (const to of all) {
      if (from === to) continue;
      const db = makeD1();
      const id = await base(db);
      db.raw.exec('DROP TRIGGER trg_orders_state_guard');           // force the starting state, then put the guard back
      db.raw.exec('PRAGMA ignore_check_constraints = ON');
      db.raw.prepare('UPDATE orders SET state = ? WHERE id = ?').run(from, id);
      db.raw.exec('PRAGMA ignore_check_constraints = OFF');
      db.raw.exec(guardSql);
      let dbAllows = true;
      try { db.raw.prepare('UPDATE orders SET state = ? WHERE id = ?').run(to, id); } catch (e) { if (String(e.message).includes('illegal order state transition')) dbAllows = false; }
      assert.equal(dbAllows, canTransition(from, to), `${from} -> ${to}`);
      checked++;
    }
    assert.equal(checked, all.length * (all.length - 1));
  });
  test('compare-and-set: only one of two racing transitions wins', async () => {
    const db = makeD1();
    const id = await base(db);
    const a = await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'PAID', actor: 'payu_callback' });
    const b = await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'PAID', actor: 'payu_webhook' });
    assert.deepEqual([a.ok, b.ok, b.code], [true, false, 'state_changed']);
    assert.equal((await state(db, id)).version, 1);
  });
  test('illegal and unknown-actor transitions are refused before touching the database', async () => {
    const db = makeD1();
    const id = await base(db);
    assert.equal((await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'CONFIRMED', actor: 'api' })).code, 'illegal_transition');
    assert.equal((await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'PAID', actor: 'hacker' })).code, 'bad_actor');
    assert.equal((await state(db, id)).state, 'PAYMENT_PENDING');
  });
  test('every state change writes an audit event with the actor', async () => {
    const db = makeD1();
    const id = await base(db);
    await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'PAID', actor: 'payu_callback' });
    await transition(db, { orderId: id, from: 'PAID', to: 'PUSHED_TO_RISTA', actor: 'api' });
    await transition(db, { orderId: id, from: 'PUSHED_TO_RISTA', to: 'CONFIRMED', actor: 'cron' });
    const ev = await events(db, id);
    assert.deepEqual(ev.map((e) => `${e.from_state}>${e.to_state}:${e.actor}`), ['null>PAYMENT_PENDING:api', 'PAYMENT_PENDING>PAID:payu_callback', 'PAID>PUSHED_TO_RISTA:api', 'PUSHED_TO_RISTA>CONFIRMED:cron']);
    assert.ok((await db.prepare('SELECT confirmed_at FROM orders WHERE id = ?').bind(id).first()).confirmed_at);
  });
  test('a cod order cannot be moved into a payment state (database check)', async () => {
    const db = makeD1();
    const id = await base(db, { method: 'cod', subtotalPaise: 60000, taxPaise: 3000, totalPaise: 63000 });
    assert.equal((await state(db, id)).state, 'CREATED');
    assert.equal((await transition(db, { orderId: id, from: 'CREATED', to: 'PUSHED_TO_RISTA', actor: 'api' })).ok, true);
  });

  describe('markPaid', () => {
    test('success moves PAYMENT_PENDING to PAID and marks the payment SUCCESS', async () => {
      const db = makeD1();
      const id = await base(db);
      const r = await markPaid(db, { orderId: id, txnid: id, payuRef: '777', amountPaise: 63000, actor: 'payu_callback' });
      assert.deepEqual(r, { ok: true });
      assert.equal((await state(db, id)).state, 'PAID');
      const p = await db.prepare('SELECT status, payu_ref, amount_paise FROM payments WHERE txnid = ?').bind(id).first();
      assert.deepEqual([p.status, p.payu_ref, p.amount_paise], ['SUCCESS', '777', 63000]);
    });
    test('duplicate callback then webhook: second call is a harmless duplicate, state changes once', async () => {
      const db = makeD1();
      const id = await base(db);
      await markPaid(db, { orderId: id, txnid: id, payuRef: '777', amountPaise: 63000, actor: 'payu_callback' });
      const r2 = await markPaid(db, { orderId: id, txnid: id, payuRef: '777', amountPaise: 63000, actor: 'payu_webhook' });
      assert.deepEqual(r2, { ok: true, duplicate: true });
      assert.equal((await state(db, id)).version, 1);
      assert.equal((await events(db, id)).length, 2);
    });
    test('amount tampering: order stays PAYMENT_PENDING, payment flagged MISMATCH', async () => {
      const db = makeD1();
      const id = await base(db);
      const r = await markPaid(db, { orderId: id, txnid: id, payuRef: '1', amountPaise: 100, actor: 'payu_callback' });
      assert.equal(r.code, 'amount_mismatch');
      assert.equal((await state(db, id)).state, 'PAYMENT_PENDING');
      assert.equal((await db.prepare('SELECT status FROM payments WHERE txnid = ?').bind(id).first()).status, 'MISMATCH');
    });
    test('late payment on an expired order: money taken, order goes to REFUND_NEEDED', async () => {
      const db = makeD1();
      const id = await base(db);
      await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'EXPIRED', actor: 'cron' });
      const r = await markPaid(db, { orderId: id, txnid: id, payuRef: '9', amountPaise: 63000, actor: 'payu_webhook' });
      assert.deepEqual([r.ok, r.code, r.refundNeeded], [false, 'late_payment', true]);
      assert.equal((await state(db, id)).state, 'REFUND_NEEDED');
    });
    test('unknown order and bad inputs', async () => {
      const db = makeD1();
      assert.equal((await markPaid(db, { orderId: 'RR-1', txnid: 'RR-1', amountPaise: 5, actor: 'api' })).code, 'not_found');
      assert.equal((await markPaid(db, { orderId: 'RR-1', txnid: 'RR-1', amountPaise: 5.5, actor: 'api' })).code, 'bad_amount');
      assert.equal((await markPaid(db, { orderId: 'RR-1', txnid: 'RR-1', amountPaise: 5, actor: 'x' })).code, 'bad_actor');
    });
  });
});
