import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleOrder, buildSale } from '../src/order.js';

const CAT = { taxTypes: [{ taxTypeId: 'c', percentage: 2.5 }, { taxTypeId: 's', percentage: 2.5 }], items: [
  { type: 'Simple', itemId: 'i1', skuCode: 'EX', itemName: 'Achari Chicken Tikka', price: 405, isPriceIncludesTax: false, taxTypeIds: ['c', 's'], status: 'Active' },
  { type: 'Simple', itemId: 'i2', skuCode: 'NP', itemName: 'No Price', status: 'Active' } ] };
const H = (sold = null) => ({ outlets: [{ code: 'MR' }, { code: 'SN' }], channel: 'Website', loadCatalog: async () => ({ value: CAT }), loadSold: async () => ({ sold }) });
const ENV = { COD_TEST_CODE: 'secret-123', RISTA_KEY: 'k', RISTA_SECRET: 's3cr3t' };
const rq = (b) => new Request('https://x/api/order', { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b) });
const GOOD = { code: 'secret-123', branch: 'MR', name: 'Test Person', phone: '98480 12345', items: [{ id: 'EX', qty: 2 }] };

test('disabled or wrong code looks like "not found"', async () => {
  assert.equal((await handleOrder({}, rq(GOOD), H())).status, 404);
  assert.equal((await handleOrder(ENV, rq({ ...GOOD, code: 'nope' }), H())).status, 404);
  assert.equal((await handleOrder(ENV, rq('{bad'), H())).status, 400);
});
test('only allowed branches', async () => {
  assert.equal((await handleOrder(ENV, rq({ ...GOOD, branch: 'SN' }), H())).status, 403);
  assert.equal((await handleOrder({ ...ENV, COD_BRANCHES: 'MR,SN' }, rq({ ...GOOD, branch: 'SN' }), H())).status, 200);
});
test('bad name, phone, items', async () => {
  assert.equal((await handleOrder(ENV, rq({ ...GOOD, name: ' ' }), H())).data.error, 'bad_name');
  assert.equal((await handleOrder(ENV, rq({ ...GOOD, phone: '12345' }), H())).data.error, 'bad_phone');
  assert.equal((await handleOrder(ENV, rq({ ...GOOD, items: [] }), H())).data.error, 'bad_items');
});
test('dry run by default: payload is shown, Rista is NOT called', async () => {
  let called = 0; const f = globalThis.fetch; globalThis.fetch = async () => { called++; return new Response('{}'); };
  const r = await handleOrder(ENV, rq(GOOD), H()); globalThis.fetch = f;
  assert.equal(r.status, 200); assert.equal(r.data.dryRun, true); assert.equal(called, 0);
  assert.equal(r.data.total, 850.5);
  const p = r.data.payload;
  assert.equal(p.branchCode, 'MR'); assert.equal(p.channel, 'Website'); assert.equal(p.delivery.mode, 'Pickup'); assert.equal(p.customer.phoneNumber, '9848012345');
  assert.deepEqual(p.items, [{ shortName: 'Achari Chicken Tikka', skuCode: 'EX', quantity: 2, unitPrice: 405 }]);
  assert.match(p.note, /TEST ORDER - DO NOT PREPARE/); assert.match(p.sourceInfo.invoiceNumber, /^W[A-Z0-9]+$/);
  assert.equal(JSON.stringify(r.data).includes('s3cr3t'), false);
});
test('sold out or no price: refused with reasons', async () => {
  const a = await handleOrder(ENV, rq({ ...GOOD, items: [{ id: 'NP', qty: 1 }] }), H());
  assert.equal(a.status, 409); assert.deepEqual(a.data.lines, [{ id: 'NP', reason: 'no_price' }]);
  const b = await handleOrder(ENV, rq(GOOD), H(new Set(['ex'])));
  assert.equal(b.status, 409); assert.equal(b.data.lines[0].reason, 'sold_out');
});
test('live: Save sale then Offline payment, with a valid signed token', async () => {
  const calls = []; const f = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push({ url, o }); return new Response(JSON.stringify(url.endsWith('/sale') ? { invoiceNumber: 'INV-7' } : {}), { status: 201 }); };
  const r = await handleOrder({ ...ENV, COD_LIVE: '1' }, rq({ ...GOOD, orderId: 'WTEST12345' }), H()); globalThis.fetch = f;
  assert.equal(r.status, 200); assert.equal(r.data.dryRun, false); assert.equal(r.data.invoiceNumber, 'INV-7'); assert.equal(r.data.cashierNotified, true);
  assert.equal(calls[0].url, 'https://api.ristaapps.com/v1/sale'); assert.equal(calls[1].url, 'https://api.ristaapps.com/v1/sale/payments/offline');
  assert.deepEqual(JSON.parse(calls[1].o.body), { invoiceNumber: 'INV-7' });
  assert.equal(JSON.parse(calls[0].o.body).sourceInfo.invoiceNumber, 'WTEST12345');
  const [h, p, sig] = calls[0].o.headers['x-api-token'].split('.');
  assert.equal(sig, crypto.createHmac('sha256', 's3cr3t').update(h + '.' + p).digest('base64url'));
  const pl = JSON.parse(Buffer.from(p, 'base64url')); assert.equal(pl.iss, 'k'); assert.ok(pl.iat && pl.jti);
  assert.equal(calls[0].o.headers['x-api-key'], 'k');
});
test('live: Rista refuses -> 502, no secrets; offline failure does not undo the order', async () => {
  const f = globalThis.fetch; globalThis.fetch = async () => new Response('{"message":"bad item"}', { status: 400 });
  const r = await handleOrder({ ...ENV, COD_LIVE: '1' }, rq(GOOD), H());
  assert.equal(r.status, 502); assert.equal(r.data.status, 400); assert.equal(JSON.stringify(r.data).includes('s3cr3t'), false);
  globalThis.fetch = async (url) => url.endsWith('/sale') ? new Response('{"invoiceNumber":"I9"}', { status: 201 }) : new Response('no', { status: 403 });
  const r2 = await handleOrder({ ...ENV, COD_LIVE: '1' }, rq(GOOD), H()); globalThis.fetch = f;
  assert.equal(r2.status, 200); assert.equal(r2.data.invoiceNumber, 'I9'); assert.equal(r2.data.cashierNotified, false);
});
