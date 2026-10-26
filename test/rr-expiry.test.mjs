// node --test test/rr-expiry.test.mjs   (real migrations through testlib/d1shim.mjs; PayU is faked)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, SKIP } from './_db.mjs';
import { createOrder, newStatusToken } from '../src/orderstore.js';
import { expireUnpaid } from '../src/expiry.js';

const NOW = new Date();
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
async function order(db, minutesOld, phone = '9876543210') {
  const t = await newStatusToken();
  const r = await createOrder(db, { branch: 'moghalrajpuram', slotAt: ago(-60), method: 'payu', items: [{ ristaItemId: 'r1', name: 'Biryani', qty: 2, unitPaise: 30000 }],
    subtotalPaise: 60000, taxPaise: 3000, totalPaise: 63000, phone, name: 'Asha', statusTokenHash: t.hash, consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }], maxOpen: 99 });
  assert.equal(r.ok, true, JSON.stringify(r));
  await db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').bind(ago(minutesOld), r.orderId).run();
  return r.orderId;
}
const state = async (db, id) => (await db.prepare('SELECT state FROM orders WHERE id = ?').bind(id).first()).state;
const ENV = { PAYMENT_PROVIDER: 'payu', UNPAID_TIMEOUT_MIN: '30' };

describe('closing unpaid orders (7.4) on the real migrations', { skip: SKIP }, () => {
  test('PayU is asked first: paid -> PAID, failed -> PAYMENT_FAILED, unknown -> EXPIRED, pending or unreachable -> left alone', async () => {
    const db = makeD1();
    const paid = await order(db, 45, '9876543201'), failed = await order(db, 45, '9876543202'), gone = await order(db, 45, '9876543203');
    const pend = await order(db, 45, '9876543204'), down = await order(db, 45, '9876543205');
    const answers = { [paid]: { status: 'success', amountPaise: 63000, payuRef: 'p1' }, [failed]: { status: 'failure' }, [gone]: { status: 'not_found' }, [pend]: { status: 'pending' } };
    const asked = [];
    const r = await expireUnpaid(db, ENV, { now: NOW, payuVerify: async (env, id) => { asked.push(id); if (id === down) throw new Error('payu down'); return answers[id]; } });
    assert.deepEqual(r, { checked: 5, paid: 1, failed: 1, expired: 1, kept: 2, flagged: 0 });
    assert.equal(asked.length, 5, 'PayU was asked about every order before anything changed');
    assert.deepEqual([await state(db, paid), await state(db, failed), await state(db, gone), await state(db, pend), await state(db, down)], ['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'PAYMENT_PENDING', 'PAYMENT_PENDING']);
  });

  test('young orders are not touched; PayU is not even asked', async () => {
    const db = makeD1(); const id = await order(db, 10);
    let asked = 0;
    const r = await expireUnpaid(db, ENV, { now: NOW, payuVerify: async () => { asked++; return { status: 'not_found' }; } });
    assert.equal(r.checked, 0); assert.equal(asked, 0); assert.equal(await state(db, id), 'PAYMENT_PENDING');
  });

  test('PayU reports a different amount: not paid, flagged MISMATCH for the owner', async () => {
    const db = makeD1(); const id = await order(db, 45);
    const r = await expireUnpaid(db, ENV, { now: NOW, payuVerify: async () => ({ status: 'success', amountPaise: 100, payuRef: 'p' }) });
    assert.equal(r.flagged, 1); assert.equal(await state(db, id), 'PAYMENT_PENDING');
    assert.equal((await db.prepare('SELECT status FROM payments WHERE order_id = ?').bind(id).first()).status, 'MISMATCH');
  });

  test('PayU not set up: nothing is expired (an order PayU may have paid is never closed blind)', async () => {
    const db = makeD1(); const id = await order(db, 300);
    const r = await expireUnpaid(db, ENV, { now: NOW });
    assert.equal(r.kept, 1); assert.equal(await state(db, id), 'PAYMENT_PENDING');
  });

  test('staging demo orders (mock payments with ALLOW_MOCKS) are simply expired', async () => {
    const db = makeD1(); const id = await order(db, 45);
    const r = await expireUnpaid(db, { PAYMENT_PROVIDER: 'mock', ALLOW_MOCKS: 'true' }, { now: NOW });
    assert.equal(r.expired, 1); assert.equal(await state(db, id), 'EXPIRED');
  });

  test('the timeout comes from UNPAID_TIMEOUT_MIN and cannot go below 15 minutes', async () => {
    const db = makeD1(); const id = await order(db, 20);
    assert.equal((await expireUnpaid(db, { ...ENV, UNPAID_TIMEOUT_MIN: '30' }, { now: NOW, payuVerify: async () => ({ status: 'not_found' }) })).checked, 0);
    assert.equal((await expireUnpaid(db, { ...ENV, UNPAID_TIMEOUT_MIN: '1' }, { now: NOW, payuVerify: async () => ({ status: 'not_found' }) })).expired, 1);
    assert.equal(await state(db, id), 'EXPIRED');
  });
});
