// Task 7.1 storage side: create an order atomically, status token, idempotency. No routes here: the route handler calls these.
// Everything goes through ONE db.batch(), so an order never exists without its items, consent rows and payment row.
import { checkMethod, isPaise } from './pay.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

export async function newStatusToken() {
  const token = hex(crypto.getRandomValues(new Uint8Array(16))); // 128-bit, shown to the customer once
  return { token, hash: await sha256hex(token) };
}

// RR-<yymmdd IST><5 digits>. Digits only (the table requires GLOB 'RR-[0-9]*'), 14 chars (PayU txnid limit is 25).
export function newOrderId(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  const yymmdd = String(ist.getUTCFullYear() % 100).padStart(2, '0') + String(ist.getUTCMonth() + 1).padStart(2, '0') + String(ist.getUTCDate()).padStart(2, '0');
  const r = crypto.getRandomValues(new Uint32Array(1))[0] % 100000;
  return `RR-${yymmdd}${String(r).padStart(5, '0')}`;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const CUSTOMER = '(SELECT id FROM customers WHERE phone = ?)';

export async function createOrder(db, o) {
  const { branch, slotAt, method, items, subtotalPaise, taxPaise, chargesPaise = 0, totalPaise, phone, name = null, email = null, statusTokenHash, earnPoints = 0, consents = [], actor = 'api', now = new Date(), maxOpen = 2, codMaxPaise, codAllowedForBranch = true } = o;

  if (!/^[6-9]\d{9}$/.test(phone || '')) return { ok: false, code: 'bad_phone' };
  if (!/^[a-z0-9-]{2,40}$/.test(branch || '')) return { ok: false, code: 'bad_branch' };
  if (typeof slotAt !== 'string' || Number.isNaN(Date.parse(slotAt))) return { ok: false, code: 'bad_slot' };
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) return { ok: false, code: 'bad_items' };
  let sum = 0;
  for (const it of items) {
    if (!it.ristaItemId || !it.name || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > 20 || !isPaise(it.unitPaise)) return { ok: false, code: 'bad_items' };
    sum += it.unitPaise * it.qty;
  }
  if (![subtotalPaise, taxPaise, chargesPaise, totalPaise].every(isPaise) || sum !== subtotalPaise || totalPaise !== subtotalPaise + taxPaise + chargesPaise || totalPaise <= 0) return { ok: false, code: 'totals_mismatch' };
  const m = checkMethod(method, totalPaise, { codMaxPaise, codAllowedForBranch });
  if (!m.ok) return m;
  if (!consents.some((c) => c.kind === 'terms' && c.granted === true && c.wordingVersion)) return { ok: false, code: 'terms_required' };
  if (!statusTokenHash) return { ok: false, code: 'bad_token_hash' };

  // Open-order cap (plan 5.3). Not race-proof across two simultaneous requests: acceptable at this volume, the owner sees every order.
  const cap = await db.prepare('SELECT open_count FROM v_open_orders WHERE customer_id = ' + CUSTOMER).bind(phone).first();
  if (cap && cap.open_count >= maxOpen) return { ok: false, code: 'too_many_open_orders' };

  const state = method === 'payu' ? 'PAYMENT_PENDING' : 'CREATED';
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newOrderId(now);
    const stmts = [
      db.prepare(`INSERT INTO customers (phone, name, email) VALUES (?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, name), email = COALESCE(excluded.email, email), updated_at = ${NOW}`).bind(phone, name, email),
      db.prepare(`INSERT INTO orders (id, branch, slot_at, method, state, subtotal_paise, tax_paise, charges_paise, total_paise, customer_id, status_token_hash, earn_points, last_actor, last_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${CUSTOMER}, ?, ?, ?, 'created')`).bind(id, branch, slotAt, method, state, subtotalPaise, taxPaise, chargesPaise, totalPaise, phone, statusTokenHash, earnPoints, actor),
      ...items.map((it) => db.prepare('INSERT INTO order_items (order_id, rista_item_id, name, qty, unit_paise, line_paise) VALUES (?, ?, ?, ?, ?, ?)').bind(id, String(it.ristaItemId), it.name, it.qty, it.unitPaise, it.unitPaise * it.qty)),
      ...consents.map((c) => db.prepare(`INSERT INTO consents (customer_id, kind, granted, wording_version, order_id, ip_hash) VALUES (${CUSTOMER}, ?, ?, ?, ?, ?)`).bind(phone, c.kind, c.granted ? 1 : 0, c.wordingVersion, id, c.ipHash || null)),
    ];
    if (method === 'payu') stmts.push(db.prepare("INSERT INTO payments (order_id, txnid, status, amount_paise) VALUES (?, ?, 'INITIATED', ?)").bind(id, id, totalPaise));
    try {
      await db.batch(stmts);
      return { ok: true, orderId: id, state };
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE') && String(e.message).includes('orders.id')) continue; // id collision: new id
      throw e;
    }
  }
  return { ok: false, code: 'id_collision' };
}

// GET /api/order/status?id=&t= : needs the secret status token, so order ids cannot be enumerated.
export async function getOrderStatus(db, { id, t }) {
  if (!id || !t) return null;
  const row = await db.prepare('SELECT id, branch, slot_at, method, state, total_paise, earn_points, status_token_hash, updated_at FROM orders WHERE id = ?').bind(id).first();
  if (!row) return null;
  const h = await sha256hex(t);
  if (h.length !== row.status_token_hash.length) return null;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ row.status_token_hash.charCodeAt(i);
  if (diff !== 0) return null;
  const { status_token_hash, ...safe } = row;
  return safe;
}

// Idempotency for POST /checkout/start (contract section 1). Same key + same request = replay the stored answer. Same key + other request = 409.
export async function beginIdempotent(db, { key, phone, requestHash, now = new Date(), ttlSec = 86400 }) {
  if (typeof key !== 'string' || key.length < 16 || key.length > 64) return { kind: 'bad_key' };
  const nowIso = now.toISOString();
  await db.prepare('DELETE FROM idempotency_keys WHERE key = ? AND expires_at <= ?').bind(key, nowIso).run();
  try {
    await db.prepare('INSERT INTO idempotency_keys (key, phone, request_hash, expires_at) VALUES (?, ?, ?, ?)').bind(key, phone, requestHash, new Date(now.getTime() + ttlSec * 1000).toISOString()).run();
    return { kind: 'new' };
  } catch (e) {
    if (!String(e && e.message).includes('UNIQUE')) throw e;
  }
  const row = await db.prepare('SELECT phone, request_hash, response_json FROM idempotency_keys WHERE key = ?').bind(key).first();
  if (!row || row.phone !== phone || row.request_hash !== requestHash) return { kind: 'conflict' };
  return row.response_json ? { kind: 'replay', response: JSON.parse(row.response_json) } : { kind: 'in_progress' };
}

export async function finishIdempotent(db, { key, orderId, response }) {
  await db.prepare('UPDATE idempotency_keys SET order_id = ?, response_json = ? WHERE key = ?').bind(orderId, JSON.stringify(response), key).run();
}
