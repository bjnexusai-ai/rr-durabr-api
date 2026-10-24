// Task 4.4: order state machine, application side. The database enforces the same table with a trigger (migration 0002),
// so a bug here cannot create an illegal state. Every change is a compare-and-set: UPDATE ... WHERE id=? AND state=<expected>.
// If two requests race (callback and webhook), exactly one gets changes = 1; the other gets { ok:false, code:'state_changed' }.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export const TRANSITIONS = {
  CREATED: ['PUSHED_TO_RISTA', 'PUSH_FAILED'],
  PAYMENT_PENDING: ['PAID', 'PAYMENT_FAILED', 'EXPIRED'],
  PAID: ['PUSHED_TO_RISTA', 'PUSH_FAILED'],
  PUSH_FAILED: ['PUSHED_TO_RISTA', 'REFUND_NEEDED', 'CANCELLED'],
  PUSHED_TO_RISTA: ['CONFIRMED'],
  PAYMENT_FAILED: ['REFUND_NEEDED'],
  EXPIRED: ['REFUND_NEEDED'],
  REFUND_NEEDED: ['REFUNDED'],
  CONFIRMED: [],
  REFUNDED: [],
  CANCELLED: [],
};
export const ACTORS = ['api', 'payu_callback', 'payu_webhook', 'cron', 'owner'];

export const canTransition = (from, to) => Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));

function casStatement(db, { orderId, from, to, actor, note }) {
  return db.prepare(
    `UPDATE orders SET state = ?, version = version + 1, last_actor = ?, last_note = ?, updated_at = ${NOW},
       confirmed_at = CASE WHEN ? = 'CONFIRMED' THEN ${NOW} ELSE confirmed_at END
     WHERE id = ? AND state = ?`,
  ).bind(to, actor, note, to, orderId, from);
}

function mapDbError(e) {
  const m = String((e && e.message) || e);
  if (m.includes('illegal order state transition')) return { ok: false, code: 'illegal_transition' };
  if (m.includes('CHECK constraint')) return { ok: false, code: 'constraint' };
  return null;
}

export async function transition(db, { orderId, from, to, actor, note = null }) {
  if (!ACTORS.includes(actor)) return { ok: false, code: 'bad_actor' };
  if (!canTransition(from, to)) return { ok: false, code: 'illegal_transition' };
  try {
    const r = await casStatement(db, { orderId, from, to, actor, note }).run();
    return r.meta.changes === 1 ? { ok: true } : { ok: false, code: 'state_changed' };
  } catch (e) {
    const mapped = mapDbError(e);
    if (mapped) return mapped;
    throw e;
  }
}

// Called by the PayU callback/webhook AFTER the hash and the server-to-server verify have passed (see payu.js).
// Idempotent: a second call for the same payment returns { ok:true, duplicate:true } and changes nothing.
export async function markPaid(db, { orderId, txnid, payuRef = null, amountPaise, actor }) {
  if (!ACTORS.includes(actor)) return { ok: false, code: 'bad_actor' };
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return { ok: false, code: 'bad_amount' };
  const order = await db.prepare('SELECT id, state, total_paise FROM orders WHERE id = ?').bind(orderId).first();
  if (!order) return { ok: false, code: 'not_found' };

  // Amount must equal the server total. Otherwise flag it and do NOT move the order (plan section 7, money rules).
  if (amountPaise !== order.total_paise) {
    await db.prepare("UPDATE payments SET status = 'MISMATCH', amount_paise = ?, payu_ref = ? WHERE txnid = ? AND status = 'INITIATED'").bind(amountPaise, payuRef, txnid).run();
    return { ok: false, code: 'amount_mismatch' };
  }

  const [payRes, orderRes] = await db.batch([
    db.prepare(`UPDATE payments SET status = 'SUCCESS', payu_ref = ?, amount_paise = ?, verified_at = ${NOW} WHERE txnid = ? AND order_id = ? AND status = 'INITIATED'`).bind(payuRef, amountPaise, txnid, orderId),
    casStatement(db, { orderId, from: 'PAYMENT_PENDING', to: 'PAID', actor, note: `payu ${payuRef || ''}`.trim() }),
  ]);

  if (payRes.meta.changes === 1 && orderRes.meta.changes === 1) return { ok: true };
  if (payRes.meta.changes === 0) return { ok: true, duplicate: true }; // already processed by the other path
  // Money was captured but the order is no longer waiting for payment (expired or failed earlier): the owner must refund.
  const now = await db.prepare('SELECT state FROM orders WHERE id = ?').bind(orderId).first();
  if (now && (now.state === 'EXPIRED' || now.state === 'PAYMENT_FAILED')) {
    await transition(db, { orderId, from: now.state, to: 'REFUND_NEEDED', actor, note: 'late payment' });
    return { ok: false, code: 'late_payment', refundNeeded: true };
  }
  return { ok: false, code: 'unexpected_state', state: now && now.state };
}
