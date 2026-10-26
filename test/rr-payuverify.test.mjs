// node --test test/payuverify.test.mjs   (no network: PayU is faked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePayuVerify, amtToPaise, PAYU_VERIFY_URL } from '../src/payuverify.js';
import { sha512hex } from '../src/payu.js';

const ENV = { PAYU_KEY: 'testkey', PAYU_SALT: 'testsalt', PAYU_MODE: 'test' };
function fakePayu(reply, seen = []) {
  return async (url, init) => { seen.push({ url, init, body: Object.fromEntries(new URLSearchParams(String(init.body))) }); if (reply instanceof Error) throw reply; return { ok: true, json: async () => reply }; };
}
const ok = (txn, extra = {}) => ({ status: 1, msg: '1 out of 1 Transactions Fetched Successfully', transaction_details: { [txn]: { mihpayid: '403993715531', amt: '680.40', txnid: txn, status: 'success', ...extra } } });

test('amounts are turned into paise without floating point', () => {
  assert.equal(amtToPaise('680.40'), 68040);
  assert.equal(amtToPaise('680.4'), 68040);
  assert.equal(amtToPaise('680'), 68000);
  assert.equal(amtToPaise(' 1000.00 '), 100000);
  for (const bad of ['', '6.804', '-1.00', 'abc', '1e3', null, undefined]) assert.equal(amtToPaise(bad), null);
});

test('sends the documented request: form POST, command, var1, hash = sha512(key|verify_payment|txnid|salt)', async () => {
  const seen = [];
  const v = makePayuVerify({ fetchImpl: fakePayu(ok('RR-100234'), seen) });
  const r = await v(ENV, 'RR-100234');
  assert.deepEqual(r, { status: 'success', amountPaise: 68040, payuRef: '403993715531' });
  assert.equal(seen[0].url, PAYU_VERIFY_URL.test);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(seen[0].body.command, 'verify_payment');
  assert.equal(seen[0].body.var1, 'RR-100234');
  assert.equal(seen[0].body.key, 'testkey');
  assert.equal(seen[0].body.hash, await sha512hex('testkey|verify_payment|RR-100234|testsalt'));
  assert.ok(!JSON.stringify(seen[0].body).includes('testsalt'), 'salt is never sent');
});

test('live mode uses the live host; PAYU_VERIFY_URL overrides', async () => {
  const seen = [];
  await makePayuVerify({ fetchImpl: fakePayu(ok('RR-1'), seen) })({ ...ENV, PAYU_MODE: 'live' }, 'RR-1');
  assert.equal(seen[0].url, PAYU_VERIFY_URL.live);
  await makePayuVerify({ fetchImpl: fakePayu(ok('RR-1'), seen) })({ ...ENV, PAYU_VERIFY_URL: 'https://example.test/v' }, 'RR-1');
  assert.equal(seen[1].url, 'https://example.test/v');
});

test('only a clear success with a valid amount counts as success', async () => {
  const run = (reply) => makePayuVerify({ fetchImpl: fakePayu(reply) })(ENV, 'RR-7');
  assert.equal((await run(ok('RR-7', { status: 'failure' }))).status, 'failure');
  assert.equal((await run(ok('RR-7', { status: 'pending' }))).status, 'pending');
  assert.equal((await run(ok('RR-7', { status: 'Not Found' }))).status, 'not_found');
  assert.equal((await run(ok('RR-7', { status: 'bounced' }))).status, 'unknown');
  assert.equal((await run(ok('RR-7', { amt: 'abc' }))).status, 'bad_amount');
  assert.equal((await run({ status: 0, msg: 'error' })).status, 'error');
  assert.equal((await run({ status: 1, transaction_details: {} })).status, 'not_found');
  assert.equal((await run({ status: 1, transaction_details: { 'RR-7': { txnid: 'RR-8', status: 'success', amt: '1.00' } } })).status, 'error');
});

test('PayU down, missing keys or a strange txnid never give success', async () => {
  assert.equal((await makePayuVerify({ fetchImpl: fakePayu(new Error('net')) })(ENV, 'RR-1')).status, 'unreachable');
  assert.equal((await makePayuVerify({ fetchImpl: fakePayu(ok('RR-1')) })({}, 'RR-1')).status, 'unconfigured');
  assert.equal((await makePayuVerify({ fetchImpl: fakePayu(ok('RR-1')) })(ENV, 'RR 1|x')).status, 'bad_txnid');
});
