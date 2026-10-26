// RR Durbar API: turn the existing rupee quote into integer paise, exactly (plan tasks 4.1a and 4.5a). New file, not wired.
// Built from how the LIVE SITE reads POST /api/quote today: { lines: [{ id, ok, reason?, lineTotal, name?, qty? }], subtotal, tax,
// total, allOk } in rupees. [TO CHECK in 4.1a against src/quote.js makeQuote: field names, and whether charges exist.]
//
// Two uses:
//  1. toOrderingQuote(rupeeQuote, requestedItems) -> the shape src/ordering.js needs for checkout/start:
//     { ok:true, quote:{ items:[{id,name,qty,unitPaise,linePaise}], subtotalPaise, taxPaise, chargesPaise, totalPaise } }
//     or { ok:false, code:'item_unavailable', field } or { ok:false, code:'provider_down', why }.
//  2. withPaiseFields(rupeeQuote, requestedItems) -> the same rupee object PLUS the contract fields the checkout page reads
//     (items[].unitPaise, subtotalPaise, taxPaise, totalPaise). The site cart keeps reading lines/subtotal/tax/total/allOk.
// Rule: never round to make numbers fit. If the parts do not add up to the total exactly, refuse (provider_down) and log why.
// Orders are then refused instead of charging an amount nobody can explain (plan section 7, money rules).

// 349 -> 34900, 18.45 -> 1845, "18.45" -> 1845; 18.456 -> null (more than 2 decimals); negative or junk -> null.
export function rupeesToPaiseExact(v) {
  if (typeof v === 'string') { const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(v.trim()); return m ? Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0')) : null; }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const p = Math.round(v * 100);
  return Math.abs(p - v * 100) < 1e-6 ? p : null;
}

export function toOrderingQuote(q, requested = []) {
  if (!q || !Array.isArray(q.lines)) return { ok: false, code: 'provider_down', why: 'no_lines' };
  const bad = q.lines.find((l) => l && l.ok === false);
  if (bad || q.allOk === false) return { ok: false, code: 'item_unavailable', field: String((bad && bad.id) || '') };
  const want = new Map(requested.map((r) => [String(r.id), r.qty]));
  const items = [];
  for (const l of q.lines) {
    const id = String(l.id || '');
    const qty = Number.isInteger(l.qty) ? l.qty : want.get(id);
    const linePaise = rupeesToPaiseExact(l.lineTotal);
    if (!id || !Number.isInteger(qty) || qty < 1 || linePaise === null) return { ok: false, code: 'provider_down', why: `bad_line:${id}` };
    if (want.size && want.get(id) !== qty) return { ok: false, code: 'provider_down', why: `qty_changed:${id}` };
    if (linePaise % qty !== 0) return { ok: false, code: 'provider_down', why: `unit_not_whole_paise:${id}` };
    items.push({ id, name: String(l.name || l.displayName || id), qty, unitPaise: linePaise / qty, linePaise });
  }
  if (want.size && (items.length !== want.size || items.some((i) => !want.has(i.id)))) return { ok: false, code: 'provider_down', why: 'lines_do_not_match_cart' };
  const subtotalPaise = rupeesToPaiseExact(q.subtotal), taxPaise = rupeesToPaiseExact(q.tax), totalPaise = rupeesToPaiseExact(q.total);
  const chargesPaise = q.charges === undefined || q.charges === null ? 0 : rupeesToPaiseExact(q.charges);
  if ([subtotalPaise, taxPaise, totalPaise, chargesPaise].some((n) => n === null)) return { ok: false, code: 'provider_down', why: 'bad_totals' };
  if (items.reduce((a, i) => a + i.linePaise, 0) !== subtotalPaise) return { ok: false, code: 'provider_down', why: 'lines_ne_subtotal' };
  if (subtotalPaise + taxPaise + chargesPaise !== totalPaise) return { ok: false, code: 'provider_down', why: 'parts_ne_total' };
  if (totalPaise <= 0) return { ok: false, code: 'provider_down', why: 'zero_total' };
  return { ok: true, quote: { items, subtotalPaise, taxPaise, chargesPaise, totalPaise } };
}

export function withPaiseFields(q, requested = []) {
  const r = toOrderingQuote(q, requested);
  if (!r.ok) return { ...q, paiseOk: false };
  return { ...q, paiseOk: true, items: r.quote.items, subtotalPaise: r.quote.subtotalPaise, taxPaise: r.quote.taxPaise, chargesPaise: r.quote.chargesPaise, totalPaise: r.quote.totalPaise };
}

// Adapter for src/ordering.js once makeQuote's real signature is known (4.1a). makeQuoteFn(env, branchCode, items) must
// return the rupee quote above. Errors from Rista become provider_down; nothing is guessed.
export function makeOrderingQuote(makeQuoteFn) {
  return async function quote(env, { ristaCode, items }) {
    let q;
    try { q = await makeQuoteFn(env, ristaCode, items); } catch { return { ok: false, code: 'provider_down' }; }
    const r = toOrderingQuote(q, items);
    if (!r.ok && r.code === 'provider_down') console.error('quote not usable for checkout', r.why);
    return r;
  };
}
