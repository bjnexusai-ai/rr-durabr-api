// RR Durbar API: scheduled housekeeping (plan task 4.8, SAFE PART ONLY). New file, not wired.
// Deletes short-lived rows that are no longer needed: used or expired OTP tokens (otp_nonces), old OTP
// challenges, old rate-limit events and expired idempotency keys. It NEVER touches orders, order_items,
// payments, consents, events, rista_pushes, customers or loyalty_events.
// Expiring unpaid orders is deliberately NOT here: that needs PayU's verify call first (plan 7.3, 7.4),
// because an order PayU has already paid must never be expired.
//
// Wiring later (needs src/index.js, given as an exact patch in task 4.8):
//   import { housekeeping } from './housekeeping.js';
//   export default { fetch: ..., async scheduled(event, env, ctx) { ctx.waitUntil(housekeeping(env.DB)); } };
//   plus a cron trigger in wrangler.toml (deploy session).

const DEFAULT_KEEP_HOURS = 24; // longest rate window is 1 hour (10 OTP per IP per hour); 24 h keeps a day for audit

export async function housekeeping(db, { now = new Date(), keepHours = DEFAULT_KEEP_HOURS } = {}) {
  if (!db || typeof db.prepare !== 'function') return { ok: false, code: 'no_db' };
  if (!Number.isFinite(keepHours) || keepHours < 2) return { ok: false, code: 'bad_keep_hours' };
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - keepHours * 3600 * 1000).toISOString();

  // Order matters: nonces point at challenges, so nonces go first and a challenge is deleted only when nothing points at it.
  const res = await db.batch([
    db.prepare('DELETE FROM otp_nonces WHERE expires_at < ?').bind(cutoff),
    db.prepare('DELETE FROM otp_challenges WHERE expires_at < ? AND id NOT IN (SELECT challenge_id FROM otp_nonces WHERE challenge_id IS NOT NULL)').bind(cutoff),
    db.prepare('DELETE FROM rate_events WHERE at < ?').bind(cutoff),
    db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').bind(nowIso),
  ]);
  const n = (i) => Number((res[i] && res[i].meta && res[i].meta.changes) || 0);
  return { ok: true, deleted: { otpNonces: n(0), otpChallenges: n(1), rateEvents: n(2), idempotencyKeys: n(3) } };
}
