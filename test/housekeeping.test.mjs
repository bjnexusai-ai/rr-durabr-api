// node --test test/housekeeping.test.mjs   (uses the REAL migrations through testlib/d1shim.mjs; needs Node 22.5+)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, SKIP } from './_db.mjs';
import { housekeeping } from '../src/housekeeping.js';

const NOW = new Date('2026-10-26T06:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();
const ahead = (h) => new Date(NOW.getTime() + h * 3600 * 1000).toISOString();
const count = async (db, t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;

describe('housekeeping on real SQLite with the real migrations', { skip: SKIP }, () => {
  test('deletes only old short-lived rows and keeps fresh ones', async () => {
    const db = makeD1();
    // OTP challenges: one old (expired 30 h ago), one fresh (expires in 1 h)
    await db.prepare("INSERT INTO otp_challenges (id, phone, code_hash, expires_at) VALUES (1, '9876543210', 'h1', ?)").bind(ago(30)).run();
    await db.prepare("INSERT INTO otp_challenges (id, phone, code_hash, expires_at) VALUES (2, '9876543210', 'h2', ?)").bind(ahead(1)).run();
    // Nonces: old one on challenge 1, fresh one on challenge 2
    await db.prepare("INSERT INTO otp_nonces (nonce, phone, challenge_id, expires_at) VALUES ('n-old', '9876543210', 1, ?)").bind(ago(25)).run();
    await db.prepare("INSERT INTO otp_nonces (nonce, phone, challenge_id, expires_at) VALUES ('n-new', '9876543210', 2, ?)").bind(ahead(0.5)).run();
    // Rate events: one 30 h old, one 10 minutes old
    await db.prepare("INSERT INTO rate_events (bucket, key, at) VALUES ('otp_phone', '9876543210', ?)").bind(ago(30)).run();
    await db.prepare("INSERT INTO rate_events (bucket, key, at) VALUES ('otp_phone', '9876543210', ?)").bind(ago(0.2)).run();
    // Idempotency: one expired, one live
    await db.prepare("INSERT INTO idempotency_keys (key, phone, request_hash, expires_at) VALUES ('k-expired-000000001', '9876543210', 'r', ?)").bind(ago(1)).run();
    await db.prepare("INSERT INTO idempotency_keys (key, phone, request_hash, expires_at) VALUES ('k-live-0000000000001', '9876543210', 'r', ?)").bind(ahead(20)).run();

    const r = await housekeeping(db, { now: NOW });
    assert.equal(r.ok, true);
    assert.deepEqual(r.deleted, { otpNonces: 1, otpChallenges: 1, rateEvents: 1, idempotencyKeys: 1 });
    assert.equal(await count(db, 'otp_nonces'), 1);
    assert.equal(await count(db, 'otp_challenges'), 1);
    assert.equal(await count(db, 'rate_events'), 1);
    assert.equal(await count(db, 'idempotency_keys'), 1);
    assert.equal((await db.prepare('SELECT nonce FROM otp_nonces').first()).nonce, 'n-new');
  });

  test('an old challenge that a kept nonce still points at is not deleted', async () => {
    const db = makeD1();
    await db.prepare("INSERT INTO otp_challenges (id, phone, code_hash, expires_at) VALUES (1, '9876543210', 'h', ?)").bind(ago(30)).run();
    await db.prepare("INSERT INTO otp_nonces (nonce, phone, challenge_id, expires_at) VALUES ('n', '9876543210', 1, ?)").bind(ago(1)).run();
    const r = await housekeeping(db, { now: NOW });
    assert.equal(r.deleted.otpChallenges, 0);
    assert.equal(await count(db, 'otp_challenges'), 1);
  });

  test('running twice is harmless, and orders and consents are never touched', async () => {
    const db = makeD1();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first();
    assert.equal((await housekeeping(db, { now: NOW })).ok, true);
    const again = await housekeeping(db, { now: NOW });
    assert.deepEqual(again.deleted, { otpNonces: 0, otpChallenges: 0, rateEvents: 0, idempotencyKeys: 0 });
    const after = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").first();
    assert.equal(after.n, before.n);
  });
});

test('refuses a missing database or a keep window shorter than the longest rate window', async () => {
  assert.equal((await housekeeping(null)).code, 'no_db');
  assert.equal((await housekeeping({ prepare() {} }, { keepHours: 1 })).code, 'bad_keep_hours');
});

test('the module never names a money or order table', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/housekeeping.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const t of ['orders', 'order_items', 'payments', 'consents', 'events', 'rista_pushes', 'customers', 'loyalty_events']) {
    assert.ok(!new RegExp(`\\b(FROM|INTO|UPDATE)\\s+${t}\\b`, 'i').test(code), `touches ${t}`);
  }
});
