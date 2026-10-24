import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requestHashString, responseHashString, buildPayuFields, verifyPayuResponse, sha512hex, PAYU_ACTION } from '../src/payu.js';

const KEY = 'K123', SALT = 'S456';
const sha = (s) => createHash('sha512').update(s).digest('hex');

test('request hash string has the documented shape (5 udf slots, then 5 empty slots, then salt)', () => {
  const s = requestHashString({ key: KEY, salt: SALT, txnid: 'RR-26102412345', amount: '680.40', productinfo: 'P', firstname: 'A', email: 'a@x.in' });
  assert.equal(s, 'K123|RR-26102412345|680.40|P|A|a@x.in' + '|'.repeat(11) + 'S456');
  assert.equal(s.split('|').length, 17);
});
test('sha512hex matches node crypto (independent implementation)', async () => {
  assert.equal(await sha512hex('abc'), sha('abc'));
});
test('buildPayuFields: amount has 2 decimals, hash matches independent computation, guest email placeholder used', async () => {
  const { action, fields } = await buildPayuFields({ key: KEY, salt: SALT, order: { id: 'RR-26102412345', totalPaise: 68040 }, customer: { name: 'Asha', phone: '9876543210' }, urls: { surl: 'https://x/s', furl: 'https://x/f' } });
  assert.equal(action, PAYU_ACTION.test);
  assert.equal(fields.amount, '680.40');
  assert.equal(fields.email, 'orders@rrdurbar.com');
  assert.equal(fields.hash, sha(['K123', 'RR-26102412345', '680.40', 'RR Durbar pickup order', 'Asha', 'orders@rrdurbar.com', '', '', '', '', '', '', '', '', '', '', 'S456'].join('|')));
});
async function signedResponse(over = {}) {
  const p = { key: KEY, txnid: 'RR-26102412345', amount: '680.40', productinfo: 'P', firstname: 'A', email: 'a@x.in', status: 'success', mihpayid: '999', ...over };
  p.hash = over.hash || await sha512hex(responseHashString({ ...p, salt: SALT }));
  return p;
}
test('response hash: good response verifies and returns payu ref', async () => {
  const r = await verifyPayuResponse(await signedResponse(), { key: KEY, salt: SALT, expectedTxnid: 'RR-26102412345', expectedAmountPaise: 68040 });
  assert.deepEqual(r, { ok: true, status: 'success', payuRef: '999' });
});
test('response hash string: salt first, status, 5 empty slots, udf5..udf1 reversed, then email..key', () => {
  const s = responseHashString({ key: KEY, salt: SALT, status: 'success', txnid: 'T', amount: '1.00', productinfo: 'P', firstname: 'A', email: 'e' });
  assert.equal(s, 'S456|success' + '|'.repeat(11) + 'e|A|P|1.00|T|K123');
  const u = responseHashString({ key: KEY, salt: SALT, status: 's', txnid: 'T', amount: '1.00', productinfo: 'P', firstname: 'A', email: 'e', udf: ['1', '2', '3', '4', '5'] });
  assert.equal(u, 'S456|s|||||' + '|5|4|3|2|1|e|A|P|1.00|T|K123');
});
test('wrong hash, wrong amount, wrong txnid are all refused', async () => {
  const o = { key: KEY, salt: SALT, expectedTxnid: 'RR-26102412345', expectedAmountPaise: 68040 };
  assert.equal((await verifyPayuResponse(await signedResponse({ hash: 'f'.repeat(128) }), o)).code, 'bad_hash');
  assert.equal((await verifyPayuResponse(await signedResponse({ amount: '1.00' }), o)).code, 'amount_mismatch');
  assert.equal((await verifyPayuResponse(await signedResponse({ txnid: 'RR-OTHER' }), o)).code, 'txn_mismatch');
  assert.equal((await verifyPayuResponse(await signedResponse({ key: 'WRONG' }), o)).code, 'bad_hash');
  assert.equal((await verifyPayuResponse(null, o)).code, 'bad_hash');
});
