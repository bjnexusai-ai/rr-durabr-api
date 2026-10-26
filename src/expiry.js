// RR Durbar API: close unpaid online orders (plan task 7.4, contract 3.11). New file, not wired (runs from the scheduled job).
// Rule (plan money rules): never expire an order PayU may have paid. So for every PAYMENT_PENDING order older than the limit,
// ASK PayU first (src/payuverify.js), then:
//   PayU says success + amount  -> markPaid (if the amount differs, markPaid flags MISMATCH and does NOT mark paid)
//   PayU says failure           -> PAYMENT_FAILED
//   PayU has no such payment    -> EXPIRED
//   pending / unreachable / not set up / unclear -> leave it, try again next run (an owner alert comes with task 10.1)
// Staging only: with PAYMENT_PROVIDER=mock and ALLOW_MOCKS=true there is no PayU to ask, so old demo orders are simply expired.
// Limit: UNPAID_TIMEOUT_MIN (default 30, plan 7.4 and decision 0.10-2). At most `batch` orders per run.
import { transition, markPaid } from './orderstate.js';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

export async function expireUnpaid(db, env, { payuVerify, now = new Date(), batch = 20 } = {}) {
  const minutes = Math.max(15, Math.min(240, Number.parseInt(env.UNPAID_TIMEOUT_MIN, 10) || 30));
  const cutoff = new Date(now.getTime() - minutes * 60000).toISOString();
  const rows = (await db.prepare("SELECT id FROM orders WHERE state = 'PAYMENT_PENDING' AND created_at < ? ORDER BY created_at LIMIT ?").bind(cutoff, batch).all()).results || [];
  const mockOnly = String(env.PAYMENT_PROVIDER || '').toLowerCase() === 'mock' && truthy(env.ALLOW_MOCKS);
  const out = { checked: rows.length, paid: 0, failed: 0, expired: 0, kept: 0, flagged: 0 };
  for (const { id } of rows) {
    if (mockOnly) {
      const r = await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'EXPIRED', actor: 'cron', note: 'demo order expired' });
      if (r && r.ok) out.expired++; else out.kept++;
      continue;
    }
    let v;
    try { v = payuVerify ? await payuVerify(env, id) : { status: 'unconfigured' }; } catch { v = { status: 'unreachable' }; }
    const st = v && v.status;
    if (st === 'success' && Number.isInteger(v.amountPaise)) {
      const r = await markPaid(db, { orderId: id, txnid: id, payuRef: v.payuRef || null, amountPaise: v.amountPaise, actor: 'cron' });
      if (r.ok) out.paid++; else if (r.code === 'amount_mismatch') out.flagged++; else out.kept++;
    } else if (st === 'failure') {
      const r = await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'PAYMENT_FAILED', actor: 'cron', note: 'payu says failed' });
      if (r && r.ok) out.failed++; else out.kept++;
    } else if (st === 'not_found') {
      const r = await transition(db, { orderId: id, from: 'PAYMENT_PENDING', to: 'EXPIRED', actor: 'cron', note: `no payment after ${minutes} min` });
      if (r && r.ok) out.expired++; else out.kept++;
    } else {
      out.kept++;
    }
  }
  return out;
}
