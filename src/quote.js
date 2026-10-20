// /api/quote: the server works out the prices. The browser never sends a price.
// Input : { branch:"MR", items:[ { id:"New_230126_31", qty:2 }, ... ] }   (ids come from /api/menu)
// Output: each line with its price from Rista (Website channel), subtotal, GST, total.
// All money is counted in paise (whole numbers) so there are no rounding surprises.
import { priceIndex } from './transform.js';

export const MAX_LINES = 40;
export const MAX_QTY = 99;

const lc = (s) => String(s ?? '').trim().toLowerCase();
const rupees = (paise) => paise / 100;

// Returns { ok:true, items:[{id,qty}] } or { ok:false, error }
export function readRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_request' };
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_LINES) return { ok: false, error: 'bad_items' };
  const merged = new Map();
  for (const it of body.items) {
    if (!it || typeof it !== 'object') return { ok: false, error: 'bad_items' };
    const id = typeof it.id === 'string' ? it.id.trim() : '';
    const qty = Number(it.qty);
    if (!id || id.length > 80 || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { ok: false, error: 'bad_items' };
    merged.set(id, Math.min(MAX_QTY, (merged.get(id) || 0) + qty));
  }
  return { ok: true, items: [...merged].map(([id, qty]) => ({ id, qty })) };
}

export function makeQuote(catalogJson, sold, items) {
  const index = priceIndex(catalogJson);
  const lines = [];
  let subtotal = 0, tax = 0;

  for (const { id, qty } of items) {
    const row = index.get(id);
    if (!row) { lines.push({ id, qty, ok: false, reason: 'unknown' }); continue; }
    const base = { id, qty, name: row.name, label: row.label || null };
    if (row.price === null) { lines.push({ ...base, ok: false, reason: 'no_price' }); continue; }
    if (sold && row.keys.some((k) => k && sold.has(lc(k)))) { lines.push({ ...base, ok: false, reason: 'sold_out' }); continue; }
    const unit = Math.round(row.price * 100);
    const lineTotal = unit * qty;
    // GST follows Rista, dish by dish. Price WITHOUT tax: add the tax. Price WITH tax: do not add it, only show how much of it is tax.
    let part;
    if (row.inc) { part = lineTotal - Math.round((lineTotal * 100) / (100 + row.taxPct)); subtotal += lineTotal - part; }
    else { part = Math.round((lineTotal * row.taxPct) / 100); subtotal += lineTotal; }
    tax += part;
    lines.push({ ...base, ok: true, unitPrice: rupees(unit), lineTotal: rupees(lineTotal), taxIncluded: row.inc });
  }

  return {
    lines,
    allOk: lines.every((l) => l.ok),
    subtotal: rupees(subtotal),
    tax: rupees(tax),            // GST from the tax rates saved in Rista for each dish
    total: rupees(subtotal + tax),
    taxIncluded: lines.some((l) => l.ok) && lines.filter((l) => l.ok).every((l) => l.taxIncluded),
  };
}

// { "<dish id>": <Website price in rupees> } for every dish that has a Website price. Used for the prices on the menu cards.
export function pricesFor(catalogJson) {
  const out = {};
  for (const row of priceIndex(catalogJson).values()) if (row.price !== null && row.id) out[row.id] = row.price;
  return out;
}
