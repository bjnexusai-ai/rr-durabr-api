import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/token.js';

const S = 'test-secret-0123456789abcdef';
test('sign then verify returns phone and nonce', async () => {
  const t = await signToken(S, { phone: '9876543210', nonce: 'abc', nowMs: 1000000 });
  const v = await verifyToken(S, t, 1000000 + 1000);
  assert.deepEqual({ ok: v.ok, phone: v.phone, nonce: v.nonce }, { ok: true, phone: '9876543210', nonce: 'abc' });
});
test('expired token is refused', async () => {
  const t = await signToken(S, { phone: '9876543210', nonce: 'abc', ttlSec: 60, nowMs: 1000000 });
  assert.equal((await verifyToken(S, t, 1000000 + 61000)).code, 'token_expired');
});
test('tampered body, wrong secret and junk are refused', async () => {
  const t = await signToken(S, { phone: '9876543210', nonce: 'abc' });
  const [b, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ p: '9000000000', n: 'abc', exp: 9999999999 })).toString('base64url');
  assert.equal((await verifyToken(S, `${forged}.${s}`)).code, 'token_invalid');
  assert.equal((await verifyToken('another-secret-0123456789', t)).code, 'token_invalid');
  assert.equal((await verifyToken(S, 'x')).code, 'token_invalid');
  assert.equal((await verifyToken(S, undefined)).code, 'token_invalid');
  assert.ok(b.length > 10);
});
test('short secret is refused at signing', async () => {
  await assert.rejects(() => signToken('short', { phone: '9876543210', nonce: 'a' }));
});
