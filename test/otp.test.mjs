import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, SKIP } from './_db.mjs';
import { generateCode, issueOtp, verifyOtp, claimNonce, rateCheck, mockSender, hashCode } from '../src/otp.js';

const S = 'otp-secret-0123456789abcdef', P = '9876543210';
const T0 = new Date('2026-10-24T05:00:00Z');
const plus = (s) => new Date(T0.getTime() + s * 1000);

test('generateCode is always 6 digits', () => { for (let i = 0; i < 500; i++) assert.match(generateCode(), /^\d{6}$/); });

describe('OTP on real SQLite', { skip: SKIP }, () => {
  test('issue then verify with the right code returns a nonce; the raw code is not stored', async () => {
    const db = makeD1(), sender = mockSender();
    assert.equal((await issueOtp(db, { phone: P, secret: S, sender, now: T0 })).ok, true);
    const code = sender.sent[0].code;
    const row = await db.prepare('SELECT code_hash FROM otp_challenges').first();
    assert.notEqual(row.code_hash, code);
    assert.equal(row.code_hash, await hashCode(S, P, code));
    const v = await verifyOtp(db, { phone: P, code, secret: S, now: plus(30) });
    assert.equal(v.ok, true); assert.match(v.nonce, /^[0-9a-f]{32}$/);
  });
  test('a code works once only', async () => {
    const db = makeD1(), sender = mockSender();
    await issueOtp(db, { phone: P, secret: S, sender, now: T0 });
    const code = sender.sent[0].code;
    assert.equal((await verifyOtp(db, { phone: P, code, secret: S, now: plus(10) })).ok, true);
    assert.equal((await verifyOtp(db, { phone: P, code, secret: S, now: plus(11) })).code, 'otp_expired');
  });
  test('wrong code reports attempts left; the 6th try is locked even with the right code', async () => {
    const db = makeD1(), sender = mockSender();
    await issueOtp(db, { phone: P, secret: S, sender, now: T0 });
    const code = sender.sent[0].code, wrong = code === '000000' ? '111111' : '000000';
    const left = [];
    for (let i = 0; i < 5; i++) left.push((await verifyOtp(db, { phone: P, code: wrong, secret: S, now: plus(i + 1) })).attemptsLeft);
    assert.deepEqual(left, [4, 3, 2, 1, 0]);
    assert.equal((await verifyOtp(db, { phone: P, code, secret: S, now: plus(9) })).code, 'otp_locked');
  });
  test('code expires after 5 minutes', async () => {
    const db = makeD1(), sender = mockSender();
    await issueOtp(db, { phone: P, secret: S, sender, now: T0 });
    assert.equal((await verifyOtp(db, { phone: P, code: sender.sent[0].code, secret: S, now: plus(301) })).code, 'otp_expired');
  });
  test('a new code cancels the old one', async () => {
    const db = makeD1(), sender = mockSender();
    await issueOtp(db, { phone: P, secret: S, sender, now: T0 });
    await issueOtp(db, { phone: P, secret: S, sender, now: plus(40) });
    const [first, second] = sender.sent.map((s) => s.code);
    if (first !== second) assert.equal((await verifyOtp(db, { phone: P, code: first, secret: S, now: plus(50) })).ok, false);
    assert.equal((await verifyOtp(db, { phone: P, code: second, secret: S, now: plus(51) })).ok, true);
  });
  test('rate limit: 4th send in 10 minutes is refused with a wait time; allowed again later', async () => {
    const db = makeD1(), sender = mockSender();
    for (let i = 0; i < 3; i++) assert.equal((await issueOtp(db, { phone: P, secret: S, sender, now: plus(i * 5) })).ok, true);
    const r = await issueOtp(db, { phone: P, secret: S, sender, now: plus(20) });
    assert.deepEqual([r.ok, r.code], [false, 'rate_limited']);
    assert.ok(r.retryAfterSeconds > 0 && r.retryAfterSeconds <= 600);
    assert.equal(sender.sent.length, 3);
    assert.equal((await issueOtp(db, { phone: P, secret: S, sender, now: plus(700) })).ok, true);
  });
  test('per-IP limit: 11th send from one IP in an hour is refused, different phones', async () => {
    const db = makeD1(), sender = mockSender();
    for (let i = 0; i < 10; i++) assert.equal((await issueOtp(db, { phone: `98765432${String(10 + i)}`, secret: S, sender, ipHash: 'ip1', now: plus(i) })).ok, true);
    assert.equal((await issueOtp(db, { phone: '9876543299', secret: S, sender, ipHash: 'ip1', now: plus(11) })).code, 'rate_limited');
  });
  test('sender failure is reported as provider_down and the code is dead', async () => {
    const db = makeD1();
    const r = await issueOtp(db, { phone: P, secret: S, sender: { async send() { return { ok: false }; } }, now: T0 });
    assert.equal(r.code, 'provider_down');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM otp_challenges WHERE consumed_at IS NULL').first()).n, 0);
  });
  test('bad phone is refused before anything is stored', async () => {
    const db = makeD1();
    assert.equal((await issueOtp(db, { phone: '12345', secret: S, sender: mockSender(), now: T0 })).code, 'bad_phone');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM rate_events').first()).n, 0);
  });
  test('nonce: one use by default, wrong phone and expired are refused', async () => {
    const db = makeD1(), sender = mockSender();
    await issueOtp(db, { phone: P, secret: S, sender, now: T0 });
    const { nonce } = await verifyOtp(db, { phone: P, code: sender.sent[0].code, secret: S, now: plus(5) });
    assert.equal(await claimNonce(db, { nonce, phone: '9000000000', now: plus(6) }), false);
    assert.equal(await claimNonce(db, { nonce, phone: P, now: plus(7) }), true);
    assert.equal(await claimNonce(db, { nonce, phone: P, now: plus(8) }), false);
    assert.equal(await claimNonce(db, { nonce: 'nope', phone: P, now: plus(8) }), false);
  });
  test('nonce expires with the token lifetime', async () => {
    const db = makeD1(), sender = mockSender();
    await issueOtp(db, { phone: P, secret: S, sender, now: T0 });
    const { nonce } = await verifyOtp(db, { phone: P, code: sender.sent[0].code, secret: S, now: plus(5) });
    assert.equal(await claimNonce(db, { nonce, phone: P, now: plus(5 + 1801) }), false);
  });
  test('rateCheck parallel burst cannot exceed the limit', async () => {
    const db = makeD1();
    const rs = await Promise.all(Array.from({ length: 8 }, () => rateCheck(db, { bucket: 'b', key: 'k', limit: 3, windowSec: 60, now: T0 })));
    assert.equal(rs.filter((r) => r.ok).length, 3);
  });
});
