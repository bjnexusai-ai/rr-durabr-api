// RR Durbar API: daily money check, PayU against our orders (plan task 8.5, PayU half). New file, not wired (runs once a day
// from the scheduled job, after expireUnpaid). The Rista half (our CONFIRMED orders against Rista's invoices) is added with
// the Rista adapter (8.1, 8.3): it needs Rista's Sale format.
// For every online order of the last `hours` (default 48) that is past the waiting stage, ask PayU (src/payuverify.js) and compare:
//   we say PAID / PUSHED / CONFIRMED / PUSH_FAILED, PayU says NOT success        -> ALERT "paid in our books, not at PayU"
//   we say PAID..., PayU success but a different amount than we recorded         -> ALERT "amount differs"
//   we say PAYMENT_FAILED / EXPIRED, PayU says success (money was taken)         -> markPaid moves it to REFUND_NEEDED + ALERT
//   REFUND_NEEDED still open after `refundHours` (default 24)                     -> ALERT "refund still open"
//   PayU unreachable / not set up for an order                                    -> counted as unchecked, tried again tomorrow
// It never marks an order PAID that is not waiting for payment, and never touches pay-at-pickup orders.
// `alert(text)` is the owner alert (task 10.1); one message per run, only when there is something to act on.
import { markPaid } from './orderstate.js';

const AFTER_PAID = ['PAID', 'PUSHED_TO_RISTA', 'CONFIRMED', 'PUSH_FAILED'];
const rs = (p) => `Rs ${(p / 100).toFixed(2)}`;

export async function reconcilePayu(db, env, { payuVerify, alert = async () => {}, now = new Date(), hours = 48, refundHours = 24, batch = 200 } = {}) {
  const since = new Date(now.getTime() - hours * 3600000).toISOString();
  const rows = (await db.prepare(
    `SELECT o.id, o.state, o.total_paise, o.updated_at, (SELECT amount_paise FROM payments p WHERE p.order_id = o.id AND p.status = 'SUCCESS') AS paid_paise
       FROM orders o WHERE o.method = 'payu' AND o.created_at >= ? AND o.state NOT IN ('PAYMENT_PENDING','REFUNDED','CANCELLED') ORDER BY o.created_at LIMIT ?`,
  ).bind(since, batch).all()).results || [];
  const out = { checked: 0, ok: 0, unchecked: 0, refundNeeded: [], problems: [], openRefunds: [] };
  for (const o of rows) {
    if (o.state === 'REFUND_NEEDED') {
      if (Date.parse(o.updated_at) < now.getTime() - refundHours * 3600000) out.openRefunds.push(o.id);
      continue;
    }
    let v;
    try { v = payuVerify ? await payuVerify(env, o.id) : null; } catch { v = null; }
    if (!v || !['success', 'failure', 'not_found', 'pending'].includes(v.status)) { out.unchecked++; continue; }
    out.checked++;
    const payuPaid = v.status === 'success' && Number.isInteger(v.amountPaise);
    if (AFTER_PAID.includes(o.state)) {
      if (!payuPaid) out.problems.push(`${o.id}: paid in our records (${o.state}) but PayU says "${v.status}". Do not hand over before checking PayU.`);
      else if (v.amountPaise !== (o.paid_paise ?? o.total_paise)) out.problems.push(`${o.id}: PayU amount ${rs(v.amountPaise)}, our record ${rs(o.paid_paise ?? o.total_paise)}.`);
      else out.ok++;
    } else if (o.state === 'PAYMENT_FAILED' || o.state === 'EXPIRED') {
      if (payuPaid) {
        const r = await markPaid(db, { orderId: o.id, txnid: o.id, payuRef: v.payuRef || null, amountPaise: v.amountPaise, actor: 'cron' });
        if (r.refundNeeded) out.refundNeeded.push(`${o.id}: PayU took ${rs(v.amountPaise)} after the order was ${o.state === 'EXPIRED' ? 'closed' : 'marked failed'}. Refund it in PayU.`);
        else out.problems.push(`${o.id}: PayU says paid ${rs(v.amountPaise)} while the order is ${o.state}; could not move it (${r.code || 'unknown'}).`);
      } else out.ok++;
    } else out.ok++;
  }
  const lines = [...out.refundNeeded, ...out.problems, ...out.openRefunds.map((id) => `${id}: refund still open after ${refundHours} hours.`)];
  if (lines.length) await alert(`RR Durbar daily PayU check: ${lines.length} to act on\n` + lines.join('\n'));
  return out;
}
