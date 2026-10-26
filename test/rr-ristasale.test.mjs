// node --test test/rr-ristasale.test.mjs   (task 8.1: the Rista call; Rista is faked; real migrations for the end-to-end part)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, SKIP } from './_db.mjs';
import { createOrder, newStatusToken } from '../src/orderstore.js';
import { markPaid } from '../src/orderstate.js';
import { makeRistaPusher } from '../src/ristapush.js';
import { makeSendSale, toRistaSale } from '../src/ristasale.js';
import { buildSale } from '../src/order.js';

const ENV = { RISTA_KEY: 'k', RISTA_SECRET: 's', CHANNEL: 'Website' };
const SALE = (paid) => ({ reference: 'RR-2610240001', branchCode: 'MR', type: 'pickup', pickupAt: '2026-10-24T09:30:00.000Z', paid,
  payment: paid ? { mode: 'online', provider: 'PayU', txnid: 'RR-2610240001' } : { mode: 'pay_at_pickup' },
  customer: { name: 'Asha', phone: '9876543210' }, items: [{ ristaItemId: 'S1', name: 'Chicken 65', qty: 2, unitPaise: 24900, linePaise: 49800 }],
  subtotalPaise: 49800, taxPaise: 2490, chargesPaise: 0, totalPaise: 52290 });
const fake = (reply = { invoiceNumber: 'INV-9' }, fail) => { const calls = []; return { calls, post: async (env, path, body) => { calls.push({ path, body }); if (fail && fail(path)) { const e = new Error('x'); e.status = 500; throw e; } return path === '/sale' ? reply : {}; } }; };

test('the sale has the same shape as the tested pay-at-outlet request (src/order.js buildSale)', () => {
  const ours = toRistaSale(ENV, SALE(false));
  const theirs = buildSale({ code: 'MR', channel: 'Website', orderId: 'RR-2610240001', name: 'Asha', phone: '9876543210', note: 'n',
    quote: { lines: [{ id: 'S1', name: 'Chicken 65', qty: 2, unitPrice: 249 }] } });
  assert.deepEqual(Object.keys(ours).sort(), Object.keys(theirs).sort());
  assert.deepEqual(ours.items, theirs.items);
  assert.equal(ours.branchCode, 'MR'); assert.equal(ours.sourceInfo.invoiceNumber, 'RR-2610240001');
  assert.match(ours.note, /pickup at 15:00/); assert.match(ours.note, /PAY AT PICKUP/);
});
test('pay at pickup: Save sale, then the offline-payment note to the cashier', async () => {
  const f = fake();
  assert.deepEqual(await makeSendSale({ post: f.post })(ENV, SALE(false)), { ok: true, invoice: 'INV-9', httpCode: 200 });
  assert.deepEqual(f.calls.map((c) => c.path), ['/sale', '/sale/payments/offline']);
  assert.deepEqual(f.calls[1].body, { invoiceNumber: 'INV-9' });
  assert.deepEqual(f.calls[0].body.tags, ['WEBSITE', 'COD']);
});
test('paid online: Save sale only, tagged PAID-ONLINE, note says do not collect', async () => {
  const f = fake();
  assert.equal((await makeSendSale({ post: f.post })(ENV, SALE(true))).ok, true);
  assert.deepEqual(f.calls.map((c) => c.path), ['/sale']);
  assert.deepEqual(f.calls[0].body.tags, ['WEBSITE', 'PAID-ONLINE']); assert.match(f.calls[0].body.note, /PAID ONLINE \(PayU RR-2610240001\): DO NOT COLLECT/);
});
test('test mode marks the order DO NOT PREPARE; Rista down, no invoice or no keys = not ok (so it is retried)', async () => {
  const t = fake(); await makeSendSale({ post: t.post })({ ...ENV, RISTA_PUSH_TEST: 'true' }, SALE(false));
  assert.match(t.calls[0].body.note, /^TEST ORDER - DO NOT PREPARE/); assert.ok(t.calls[0].body.tags.includes('TEST'));
  assert.deepEqual(await makeSendSale({ post: fake({}, () => true).post })(ENV, SALE(false)), { ok: false, httpCode: 500 });
  assert.equal((await makeSendSale({ post: fake({}).post })(ENV, SALE(false))).ok, false);
  assert.equal((await makeSendSale({ post: fake().post })({}, SALE(false))).ok, false);
  const off = fake(undefined, (p) => p === '/sale/payments/offline');
  assert.equal((await makeSendSale({ post: off.post })(ENV, SALE(false))).ok, true, 'the sale is in the POS even if the cashier note fails');
});

describe('end to end with the push and retries (real migrations)', { skip: SKIP }, () => {
  test('a paid order reaches Rista through sendSale and becomes CONFIRMED with the invoice', async () => {
    const db = makeD1(); const t = await newStatusToken();
    const r = await createOrder(db, { branch: 'moghalrajpuram', slotAt: new Date(Date.now() + 3600e3).toISOString(), method: 'payu', items: [{ ristaItemId: 'S1', name: 'Chicken 65', qty: 2, unitPaise: 24900 }],
      subtotalPaise: 49800, taxPaise: 2490, totalPaise: 52290, phone: '9876543210', name: 'Asha', statusTokenHash: t.hash, consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }], maxOpen: 9 });
    await markPaid(db, { orderId: r.orderId, txnid: r.orderId, payuRef: 'p', amountPaise: 52290, actor: 'payu_callback' });
    const f = fake();
    const p = makeRistaPusher({ sendSale: makeSendSale({ post: f.post }) });
    assert.equal((await p.pushToRista({ ...ENV, DB: db }, { orderId: r.orderId })).ok, true);
    assert.equal((await db.prepare('SELECT state FROM orders WHERE id = ?').bind(r.orderId).first()).state, 'CONFIRMED');
    assert.equal(f.calls[0].body.items[0].unitPrice, 249); assert.equal(f.calls[0].body.sourceInfo.invoiceNumber, r.orderId);
  });
});

describe('index.js: the push is switched off unless RISTA_PUSH_LIVE=true', { skip: SKIP }, () => {
  test('source wiring', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(src, /pushToRista: \(env, o\) => \(truthy\(env\.RISTA_PUSH_LIVE\) \? rista\.pushToRista\(env, o\) : null\)/);
    assert.match(src, /truthy\(env\.RISTA_PUSH_LIVE\) \? \[rista\.retryPushes\(env\)/);
  });
});
