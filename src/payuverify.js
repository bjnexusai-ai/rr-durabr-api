// RR Durbar API: PayU server-to-server payment check (plan task 7.3). New file, not wired.
// Contract with src/ordering.js: deps.payuVerify(env, txnid) -> { status, amountPaise, payuRef }.
// ordering.js marks an order PAID only when status === 'success' AND amountPaise equals the order total.
//
// PayU "verify_payment" (docs.payu.in/docs/verify_payment_api, read 26 Oct 2026):
//   POST https://test.payu.in/merchant/postservice?form=2   (form encoded)
//   key=<merchant key>&command=verify_payment&var1=<txnid>&hash=sha512(key|command|var1|salt)
//   reply: { status: 1|0, msg, transaction_details: { <txnid>: { mihpayid, amt, txnid, status: success|failure|pending|Not Found, ... } } }
// The LIVE host is not on that page. Default below is PayU's long-used live host; override with Worker var PAYU_VERIFY_URL
// if PayU gives another. [TO PROVE on a PayU TEST merchant before go-live, plan 7.5.]
// Secrets used: PAYU_KEY, PAYU_SALT (Worker secrets, never in code or logs). Var: PAYU_MODE = test | live.
import { sha512hex } from './payu.js';

export const PAYU_VERIFY_URL = {
  test: 'https://test.payu.in/merchant/postservice?form=2',
  live: 'https://info.payu.in/merchant/postservice.php?form=2',
};

// "590", "590.0", "590.00" -> 59000. Anything else -> null. No floating point.
export function amtToPaise(v) {
  const s = String(v ?? '').trim();
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

export function makePayuVerify({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  return async function payuVerify(env, txnid) {
    const key = env && env.PAYU_KEY, salt = env && env.PAYU_SALT;
    if (!key || !salt) return { status: 'unconfigured' };
    const id = String(txnid || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { status: 'bad_txnid' };
    const mode = String(env.PAYU_MODE || 'test').toLowerCase() === 'live' ? 'live' : 'test';
    const url = env.PAYU_VERIFY_URL || PAYU_VERIFY_URL[mode];
    const command = 'verify_payment';
    const hash = await sha512hex(`${key}|${command}|${id}|${salt}`);
    const body = new URLSearchParams({ key, command, var1: id, hash });

    let res, j;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: ctl ? ctl.signal : undefined });
      j = await res.json();
    } catch {
      return { status: 'unreachable' };
    } finally { if (timer) clearTimeout(timer); }

    if (!res.ok || !j || Number(j.status) !== 1 || !j.transaction_details) return { status: 'error' };
    const t = j.transaction_details[id];
    if (!t || typeof t !== 'object') return { status: 'not_found' };
    if (String(t.txnid || id) !== id) return { status: 'error' };
    const st = String(t.status || '').toLowerCase();
    const status = st === 'success' ? 'success' : st === 'failure' ? 'failure' : st === 'pending' ? 'pending' : st === 'not found' ? 'not_found' : 'unknown';
    const amountPaise = amtToPaise(t.amt);
    return { status: amountPaise === null && status === 'success' ? 'bad_amount' : status, amountPaise, payuRef: t.mihpayid ? String(t.mihpayid) : null };
  };
}

export const payuVerify = makePayuVerify();
