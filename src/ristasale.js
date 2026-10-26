// RR Durbar API: the Rista call for the order push (plan 8.1, 8.3). Maps a sale from src/ristapush.js loadSale() to Rista's
// "Save sale" (POST /sale), the SAME request the tested pay-at-outlet path in src/order.js (buildSale) already uses, then:
//   pay at pickup -> POST /sale/payments/offline { invoiceNumber } (tells the cashier to collect at the counter, as src/order.js does)
//   paid online   -> no payment call yet. The sale is tagged PAID-ONLINE and the note carries the PayU reference, so the
//                    counter never collects twice. [8.3 TO DO: Rista's online-payment call; its body is not in our docs yet.]
// Switched on ONLY with RISTA_PUSH_LIVE=true (src/index.js). RISTA_PUSH_TEST=true adds "TEST ORDER - DO NOT PREPARE" (task 8.6).
// Returns { ok, invoice, httpCode } for makeRistaPusher; never throws.
import { ristaPost } from './order.js';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const rupees = (paise) => Math.round(paise) / 100;
const clean = (x, n) => String(x ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const IST = (iso) => { const d = new Date(Date.parse(iso) + 330 * 60000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

export function toRistaSale(env, sale) {
  const test = truthy(env.RISTA_PUSH_TEST);
  const paidNote = sale.paid ? `PAID ONLINE (PayU ${clean(sale.payment && sale.payment.txnid, 30)}): DO NOT COLLECT` : 'PAY AT PICKUP: collect at the counter';
  const note = clean(`${test ? 'TEST ORDER - DO NOT PREPARE. ' : ''}Website pickup at ${IST(sale.pickupAt)}. ${paidNote}. ${sale.customer.name}, ${sale.customer.phone}. Web total Rs ${rupees(sale.totalPaise).toFixed(2)}. Ref ${sale.reference}`, 400);
  return {
    branchCode: sale.branchCode, channel: env.CHANNEL || 'Website', status: 'Open',
    sourceInfo: { companyName: 'RR Durbar Website', invoiceNumber: sale.reference },
    delivery: { title: 'Pickup', mode: 'Pickup', advanceOrder: true, name: clean(sale.customer.name, 60), phoneNumber: sale.customer.phone },
    customer: { name: clean(sale.customer.name, 60), phoneNumber: sale.customer.phone },
    items: sale.items.map((i) => ({ shortName: clean(i.name, 60), skuCode: i.ristaItemId, quantity: i.qty, unitPrice: rupees(i.unitPaise) })),
    note,
    tags: ['WEBSITE', sale.paid ? 'PAID-ONLINE' : 'COD', ...(test ? ['TEST'] : [])],
  };
}

export function makeSendSale({ post = ristaPost } = {}) {
  return async function sendSale(env, sale) {
    if (!env.RISTA_KEY || !env.RISTA_SECRET) return { ok: false, httpCode: 0 };
    if (!sale || !sale.branchCode || !Array.isArray(sale.items) || !sale.items.length) return { ok: false, httpCode: 0 };
    let saved;
    try { saved = await post(env, '/sale', toRistaSale(env, sale)); }
    catch (e) { console.error('rista sale failed', e && e.status, String((e && e.detail) || '').slice(0, 200)); return { ok: false, httpCode: (e && e.status) || 0 }; }
    const invoice = (saved && (saved.invoiceNumber ?? (saved.sale && saved.sale.invoiceNumber))) ?? null;
    if (!invoice) { console.error('rista sale: no invoice number in the reply'); return { ok: false, httpCode: 200 }; }
    if (!sale.paid) {
      // Same as src/order.js: tell the cashier. If this one call fails the sale is still in the POS, so it does not fail the push.
      try { await post(env, '/sale/payments/offline', { invoiceNumber: invoice }); } catch (e) { console.error('rista offline payment note failed', e && e.status); }
    }
    return { ok: true, invoice, httpCode: 200 };
  };
}

export const sendSale = makeSendSale();
