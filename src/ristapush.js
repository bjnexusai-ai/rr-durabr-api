// RR Durbar API: send orders to the Rista POS, with retries (plan Phase 8: 8.2 to 8.4, 8.7, 7.6). New file, not wired.
// Everything EXCEPT the actual Rista call is here. The call itself is injected as sendSale(env, sale), because Rista's
// Sale and Payment input models have not been received (8.1). When they arrive, a small adapter maps `sale` (below) to Rista's
// POST /sale and POST /sale/payments. Until then pushToRista is simply not passed to ordering.js: nothing reaches Rista.
//
// Rules (plan section 7):
//  - Online orders go to Rista ONLY after PAID. Pay-at-pickup orders (Rs 1000 or less) go as CREATED, marked unpaid.
//  - Rista accepted -> PUSHED_TO_RISTA -> CONFIRMED (the customer sees CONFIRMED only now).
//  - Rista failed -> PUSH_FAILED, retried 1, 2, 5 and 10 minutes later (5 tries in all).
//  - After the last try: online (paid) orders -> REFUND_NEEDED + owner alert; pay-at-pickup orders stay PUSH_FAILED + owner alert
//    (the owner calls the customer; nothing was paid).
//  - Every try is recorded in rista_pushes (UNIQUE order+attempt), so two runs can never send the same try twice.
// [TO CONFIRM with Rista]: whether Rista rejects a second sale with the same external reference (our order id). If it does not,
// a crash between Rista accepting and us recording it could send a duplicate on retry; the owner alert covers that case.
import { transition } from './orderstate.js';

export const RETRY_MINUTES = [1, 2, 5, 10];
export const MAX_TRIES = RETRY_MINUTES.length + 1;
const SLUG_TO_CODE = { singhnagar: 'SN', moghalrajpuram: 'MR', bhavanipuram: 'BH', poranki: 'PO', autonagar: 'AT' };

export async function loadSale(db, orderId) {
  const o = await db.prepare('SELECT o.id, o.branch, o.slot_at, o.method, o.state, o.subtotal_paise, o.tax_paise, o.charges_paise, o.total_paise, c.name, c.phone FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').bind(orderId).first();
  if (!o) return null;
  const items = ((await db.prepare('SELECT rista_item_id, name, qty, unit_paise, line_paise FROM order_items WHERE order_id = ? ORDER BY rowid').bind(orderId).all()).results || [])
    .map((i) => ({ ristaItemId: i.rista_item_id, name: i.name, qty: i.qty, unitPaise: i.unit_paise, linePaise: i.line_paise }));
  const paid = o.method === 'payu';
  return {
    order: o,
    sale: {
      reference: o.id, branchCode: SLUG_TO_CODE[o.branch] || null, type: 'pickup', pickupAt: o.slot_at, paid,
      payment: paid ? { mode: 'online', provider: 'PayU', txnid: o.id } : { mode: 'pay_at_pickup' },
      customer: { name: o.name || 'Guest', phone: o.phone }, items,
      subtotalPaise: o.subtotal_paise, taxPaise: o.tax_paise, chargesPaise: o.charges_paise, totalPaise: o.total_paise,
      note: `Order ${o.id}, ${paid ? 'paid online (PayU)' : 'pay at pickup'}`,
    },
  };
}

const tries = async (db, id) => (await db.prepare('SELECT COUNT(*) AS n FROM rista_pushes WHERE order_id = ?').bind(id).first()).n;

export function makeRistaPusher({ sendSale, alert = async (env, a) => console.error('OWNER ALERT', a.type, a.orderId, a.message) } = {}) {
  async function pushOnce(env, orderId) {
    const db = env.DB;
    const loaded = await loadSale(db, orderId);
    if (!loaded) return { ok: false, code: 'not_found' };
    const { order, sale } = loaded;
    const okStates = order.method === 'payu' ? ['PAID', 'PUSH_FAILED'] : ['CREATED', 'PUSH_FAILED'];
    if (!okStates.includes(order.state)) return { ok: false, code: 'not_pushable', state: order.state };
    if (!sale.branchCode) return { ok: false, code: 'unknown_branch' };
    const attempt = (await tries(db, orderId)) + 1;
    if (attempt > MAX_TRIES) return { ok: false, code: 'gave_up' };
    // Claim this try first: a second run racing for the same try fails on UNIQUE(order_id, attempt) and stops.
    try { await db.prepare("INSERT INTO rista_pushes (order_id, attempt, status) VALUES (?, ?, 'FAILED')").bind(orderId, attempt).run(); }
    catch { return { ok: false, code: 'busy' }; }
    let r;
    try { r = sendSale ? await sendSale(env, sale) : { ok: false, httpCode: 0 }; } catch (e) { r = { ok: false, httpCode: 0 }; }
    await db.prepare('UPDATE rista_pushes SET status = ?, http_code = ? WHERE order_id = ? AND attempt = ?').bind(r && r.ok ? 'OK' : 'FAILED', (r && r.httpCode) || null, orderId, attempt).run();
    if (r && r.ok) {
      const note = r.invoice ? `rista ${String(r.invoice).slice(0, 30)}` : 'rista ok';
      const a = await transition(db, { orderId, from: order.state, to: 'PUSHED_TO_RISTA', actor: 'cron', note });
      if (!a.ok) return { ok: false, code: 'state_changed' };
      await transition(db, { orderId, from: 'PUSHED_TO_RISTA', to: 'CONFIRMED', actor: 'cron', note });
      return { ok: true, attempt };
    }
    if (order.state !== 'PUSH_FAILED') await transition(db, { orderId, from: order.state, to: 'PUSH_FAILED', actor: 'cron', note: `rista try ${attempt} failed` });
    if (attempt >= MAX_TRIES) {
      if (order.method === 'payu') {
        await transition(db, { orderId, from: 'PUSH_FAILED', to: 'REFUND_NEEDED', actor: 'cron', note: 'rista down after 5 tries' });
        await alert(env, { type: 'refund_needed', orderId, message: `Paid order ${orderId} could not reach Rista after ${MAX_TRIES} tries. Make it at the counter by hand or refund it.` });
      } else {
        await alert(env, { type: 'push_failed', orderId, message: `Pay-at-pickup order ${orderId} could not reach Rista after ${MAX_TRIES} tries. Call the customer.` });
      }
    }
    return { ok: false, code: 'failed', attempt };
  }

  // For src/ordering.js deps.pushToRista(env, { orderId, method }): first try right after PAID or pay-at-pickup creation.
  async function pushToRista(env, { orderId }) { return pushOnce(env, orderId); }

  // For the scheduled job: retries that are due, plus orders whose first try never happened (lost background task).
  async function retryPushes(env, { now = new Date(), batch = 20 } = {}) {
    const db = env.DB, out = { tried: 0, ok: 0, failed: 0 };
    const rows = (await db.prepare(`SELECT o.id, o.state, o.updated_at,
        (SELECT COUNT(*) FROM rista_pushes p WHERE p.order_id = o.id) AS n,
        (SELECT MAX(at) FROM rista_pushes p WHERE p.order_id = o.id) AS last
      FROM orders o WHERE o.state = 'PUSH_FAILED' OR (o.state = 'PAID') OR (o.state = 'CREATED' AND o.method = 'cod')
      ORDER BY o.updated_at LIMIT ?`).bind(batch).all()).results || [];
    for (const r of rows) {
      if (r.n >= MAX_TRIES) continue;
      if (r.n === 0) { if (now.getTime() - Date.parse(r.updated_at) < 2 * 60000) continue; } // give the first try 2 minutes
      else if (now.getTime() - Date.parse(r.last) < RETRY_MINUTES[Math.min(r.n - 1, RETRY_MINUTES.length - 1)] * 60000) continue;
      out.tried++;
      const res = await pushOnce(env, r.id);
      if (res.ok) out.ok++; else out.failed++;
    }
    return out;
  }
  return { pushOnce, pushToRista, retryPushes };
}
