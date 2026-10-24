// Tasks 5.1 to 5.3 core: OTP issue and verify, exact rate limits, one-use nonce. Backed by D1 (KV is not atomic).
// The SMS sender is injected. Only a mock sender exists here: MSG91 needs a DLT-approved template and its API fields must be
// checked against MSG91's current docs (plan 5.1) before msg91Sender is written. The raw code is never stored (keyed hash only).
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const PHONE = /^[6-9]\d{9}$/;

async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// 6 digits, uniform (rejection sampling, no modulo bias).
export function generateCode() {
  const limit = 4294967296 - (4294967296 % 1000000);
  let n;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit);
  return String(n % 1000000).padStart(6, '0');
}
export const hashCode = (secret, phone, code) => hmacHex(secret, `${phone}:${code}`);

export function mockSender() {
  const sent = [];
  return { sent, async send(phone, code) { sent.push({ phone, code }); return { ok: true, mock: true }; } };
}
export function msg91Sender() {
  return { async send() { throw new Error('not_documented: needs DLT template id and MSG91 docs check (plan 5.1)'); } };
}

// One INSERT decides "allowed or not" in a single statement, so two parallel requests cannot both slip under the limit.
export async function rateCheck(db, { bucket, key, limit, windowSec, now = new Date() }) {
  const from = new Date(now.getTime() - windowSec * 1000).toISOString();
  const r = await db.prepare(
    'INSERT INTO rate_events (bucket, key, at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM rate_events WHERE bucket = ? AND key = ? AND at > ?) < ?',
  ).bind(bucket, key, now.toISOString(), bucket, key, from, limit).run();
  if (r.meta.changes === 1) return { ok: true };
  const oldest = await db.prepare('SELECT MIN(at) AS at FROM rate_events WHERE bucket = ? AND key = ? AND at > ?').bind(bucket, key, from).first();
  const wait = oldest && oldest.at ? Math.max(1, Math.ceil((Date.parse(oldest.at) + windowSec * 1000 - now.getTime()) / 1000)) : windowSec;
  return { ok: false, code: 'rate_limited', retryAfterSeconds: wait };
}

export async function issueOtp(db, { phone, secret, sender, ipHash = null, now = new Date(), ttlSec = 300 }) {
  if (!PHONE.test(phone || '')) return { ok: false, code: 'bad_phone' };
  const byPhone = await rateCheck(db, { bucket: 'otp_phone', key: phone, limit: 3, windowSec: 600, now });
  if (!byPhone.ok) return byPhone;
  if (ipHash) {
    const byIp = await rateCheck(db, { bucket: 'otp_ip', key: ipHash, limit: 10, windowSec: 3600, now });
    if (!byIp.ok) return byIp;
  }
  const code = generateCode();
  await db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE phone = ? AND consumed_at IS NULL').bind(now.toISOString(), phone).run(); // only the newest code works
  const ins = await db.prepare('INSERT INTO otp_challenges (phone, code_hash, expires_at) VALUES (?, ?, ?)').bind(phone, await hashCode(secret, phone, code), new Date(now.getTime() + ttlSec * 1000).toISOString()).run();
  try {
    const sent = await sender.send(phone, code);
    if (!sent || !sent.ok) throw new Error('send failed');
  } catch {
    await db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?').bind(now.toISOString(), ins.meta.last_row_id).run();
    return { ok: false, code: 'provider_down' };
  }
  return { ok: true, resendAfterSeconds: 30 };
}

export async function verifyOtp(db, { phone, code, secret, now = new Date(), nonceTtlSec = 1800, maxUses = 1 }) {
  if (!PHONE.test(phone || '') || !/^\d{6}$/.test(code || '')) return { ok: false, code: 'otp_wrong', attemptsLeft: 0 };
  const nowIso = now.toISOString();
  const ch = await db.prepare('SELECT id, code_hash, attempts, expires_at FROM otp_challenges WHERE phone = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1').bind(phone).first();
  if (!ch) return { ok: false, code: 'otp_expired' };
  if (ch.expires_at <= nowIso) return { ok: false, code: 'otp_expired' };
  if (ch.attempts >= 5) return { ok: false, code: 'otp_locked' };
  // The database enforces the 5-attempt cap: a parallel burst of guesses cannot exceed it.
  const bump = await db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < 5 AND consumed_at IS NULL AND expires_at > ?').bind(ch.id, nowIso).run();
  if (bump.meta.changes !== 1) return { ok: false, code: 'otp_locked' };
  const attemptsLeft = 5 - (ch.attempts + 1);
  if (!safeEqual(await hashCode(secret, phone, code), ch.code_hash)) return { ok: false, code: 'otp_wrong', attemptsLeft };
  const used = await db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').bind(nowIso, ch.id).run();
  if (used.meta.changes !== 1) return { ok: false, code: 'otp_expired' }; // another request consumed it first
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  await db.prepare('INSERT INTO otp_nonces (nonce, phone, challenge_id, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)').bind(nonce, phone, ch.id, maxUses, new Date(now.getTime() + nonceTtlSec * 1000).toISOString()).run();
  return { ok: true, nonce, expiresInSeconds: nonceTtlSec };
}

// Plan 5.3 token reuse policy. Call this where the token is spent (checkout/start). true = allowed, false = used up, expired or wrong phone.
export async function claimNonce(db, { nonce, phone, now = new Date() }) {
  const r = await db.prepare('UPDATE otp_nonces SET uses = uses + 1 WHERE nonce = ? AND phone = ? AND uses < max_uses AND expires_at > ?').bind(nonce, phone, now.toISOString()).run();
  return r.meta.changes === 1;
}
