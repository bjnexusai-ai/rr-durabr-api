// Tasks 7.2 and 7.3 helpers: PayU hash and form fields. Pure functions + Web Crypto.
// [TBC - MUST VERIFY BEFORE USE]: the hash field order below is PayU's long-standing documented formula, written from memory,
// NOT checked against PayU's current docs or a test merchant account. Plan 7.2 requires that check. Do not go live until a PayU TEST
// payment with these functions is accepted by test.payu.in and the response hash verifies. Also confirm: the action path, whether a
// guest's missing email is accepted (placeholder below), and that no phone/email format rule rejects our values.
import { paiseToRupeeString } from './pay.js';

export const PAYU_ACTION = { test: 'https://test.payu.in/_payment', live: 'https://secure.payu.in/_payment' };
const enc = new TextEncoder();

export async function sha512hex(s) {
  const d = await crypto.subtle.digest('SHA-512', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const udfs = (u = []) => Array.from({ length: 5 }, (_, i) => String(u[i] ?? ''));

// key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
export function requestHashString({ key, salt, txnid, amount, productinfo, firstname, email, udf }) {
  const [u1, u2, u3, u4, u5] = udfs(udf);
  return [key, txnid, amount, productinfo, firstname, email, u1, u2, u3, u4, u5, '', '', '', '', '', salt].join('|');
}
// [additionalCharges|]SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
export function responseHashString({ key, salt, status, txnid, amount, productinfo, firstname, email, udf, additionalCharges }) {
  const [u1, u2, u3, u4, u5] = udfs(udf);
  const core = [salt, status, '', '', '', '', '', u5, u4, u3, u2, u1, email, firstname, productinfo, amount, txnid, key].join('|');
  return additionalCharges ? `${additionalCharges}|${core}` : core;
}

export async function buildPayuFields({ key, salt, mode = 'test', order, customer, urls, productinfo = 'RR Durbar pickup order', guestEmail = 'orders@rrdurbar.com' }) {
  const amount = paiseToRupeeString(order.totalPaise); // string with 2 decimals, built on the server
  const f = { key, txnid: order.id, amount, productinfo, firstname: (customer.name || 'Guest').slice(0, 60), email: customer.email || guestEmail, phone: customer.phone, surl: urls.surl, furl: urls.furl };
  f.hash = await sha512hex(requestHashString({ ...f, salt }));
  return { action: PAYU_ACTION[mode] || PAYU_ACTION.test, fields: f };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Verify a callback or webhook body (an object of PayU's posted fields). Also compares amount and txnid with what WE expect.
export async function verifyPayuResponse(p, { key, salt, expectedTxnid, expectedAmountPaise }) {
  if (!p || typeof p.hash !== 'string' || p.key !== key) return { ok: false, code: 'bad_hash' };
  const expected = await sha512hex(responseHashString({
    key, salt, status: p.status, txnid: p.txnid, amount: p.amount, productinfo: p.productinfo, firstname: p.firstname, email: p.email,
    udf: [p.udf1, p.udf2, p.udf3, p.udf4, p.udf5], additionalCharges: p.additionalCharges,
  }));
  if (!safeEqual(expected, p.hash.toLowerCase())) return { ok: false, code: 'bad_hash' };
  if (p.txnid !== expectedTxnid) return { ok: false, code: 'txn_mismatch' };
  if (p.amount !== paiseToRupeeString(expectedAmountPaise)) return { ok: false, code: 'amount_mismatch' };
  return { ok: true, status: String(p.status).toLowerCase(), payuRef: p.mihpayid || null };
}
// Even with a good hash, plan 7.3 also requires a server-to-server verify-payment call to PayU before marking PAID. Not built: needs PayU docs.
