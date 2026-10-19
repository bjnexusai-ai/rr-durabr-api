// POST /api/order  : TEST order, "pay at outlet" (COD). Goes into the outlet POS through Rista "Save sale".
// Safety: needs the secret COD_TEST_CODE. Only branches in COD_BRANCHES (default MR). Dry run unless COD_LIVE=1.
import { readRequest, makeQuote } from './quote.js';

const enc = new TextEncoder();
const b64u = (buf) => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const same = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export class OrderError extends Error { constructor(status, detail) { super('rista ' + status); this.status = status; this.detail = detail; } }

async function jwt(env) {
  const h = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64u(enc.encode(JSON.stringify({ iss: env.RISTA_KEY, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() })));
  const k = await crypto.subtle.importKey('raw', enc.encode(env.RISTA_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return h + '.' + p + '.' + b64u(await crypto.subtle.sign('HMAC', k, enc.encode(h + '.' + p)));
}

export async function ristaPost(env, path, body, timeoutMs = 15000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.ristaapps.com/v1' + path, {
      method: 'POST', signal: c.signal,
      headers: { 'x-api-key': env.RISTA_KEY, 'x-api-token': await jwt(env), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new OrderError(r.status, text.slice(0, 300));
    try { return JSON.parse(text); } catch { return {}; }
  } catch (e) { if (e instanceof OrderError) throw e; throw new OrderError(0, String(e.message || e).slice(0, 120)); }
  finally { clearTimeout(t); }
}

const cleanName = (x) => String(x ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanPhone = (x) => { let d = String(x ?? '').replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); return /^[6-9]\d{9}$/.test(d) ? d : null; };

export function buildSale({ code, channel, orderId, name, phone, quote, note }) {
  return {
    branchCode: code, channel, status: 'Open',
    sourceInfo: { companyName: 'RR Durbar Website', invoiceNumber: orderId },
    delivery: { title: 'Pickup', mode: 'Pickup', advanceOrder: false, name, phoneNumber: phone },
    customer: { name, phoneNumber: phone },
    items: quote.lines.map((l) => ({ shortName: String(l.name).slice(0, 60), ...(l.label ? { variants: l.label } : {}), skuCode: l.id, quantity: l.qty, unitPrice: l.unitPrice })),
    note, tags: ['WEBSITE', 'COD', 'TEST'],
  };
}

export async function handleOrder(env, req, h) {
  const R = (status, data) => ({ status, data });
  if (!env.COD_TEST_CODE) return R(404, { error: 'not_found' });
  let text = ''; try { text = await req.text(); } catch { return R(400, { error: 'bad_request' }); }
  if (text.length > 4000) return R(413, { error: 'too_big' });
  let body = null; try { body = JSON.parse(text); } catch { return R(400, { error: 'bad_request' }); }
  if (!same(String(body?.code ?? ''), env.COD_TEST_CODE)) return R(404, { error: 'not_found' });   // same answer as "disabled": no hints

  const code = String(body.branch || '').toUpperCase();
  const allowed = String(env.COD_BRANCHES || 'MR').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!allowed.includes(code) || !h.outlets.some((o) => o.code === code)) return R(403, { error: 'branch_not_allowed' });
  const name = cleanName(body.name); if (name.length < 2) return R(400, { error: 'bad_name' });
  const phone = cleanPhone(body.phone); if (!phone) return R(400, { error: 'bad_phone' });
  const r = readRequest(body); if (!r.ok) return R(400, { error: r.error });

  const cat = await h.loadCatalog(env, code);
  const { sold } = await h.loadSold(env, code);
  const quote = makeQuote(cat.value, sold, r.items);
  if (!quote.allOk) return R(409, { error: 'items_not_available', lines: quote.lines.filter((l) => !l.ok).map((l) => ({ id: l.id, reason: l.reason })) });

  const orderId = /^W[A-Z0-9]{6,24}$/.test(String(body.orderId || '')) ? body.orderId : 'W' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  const note = `TEST ORDER - DO NOT PREPARE. Website pickup, pay at outlet. ${name}, ${phone}. Web total Rs ${quote.total}. Ref ${orderId}`;
  const sale = buildSale({ code, channel: h.channel, orderId, name, phone, quote, note });

  if (env.COD_LIVE !== '1') return R(200, { ok: true, dryRun: true, orderId, total: quote.total, message: 'Dry run. Nothing was sent to Rista.', payload: sale });

  let saved;
  try { saved = await ristaPost(env, '/sale', sale); }
  catch (e) { console.error('order save failed:', e.status, e.detail); return R(502, { error: 'rista_rejected', status: e.status ?? null, detail: e.detail ?? null, orderId }); }
  const invoice = saved?.invoiceNumber ?? saved?.sale?.invoiceNumber ?? null;
  let notified = false;
  if (invoice && env.COD_OFFLINE !== '0') { try { await ristaPost(env, '/sale/payments/offline', { invoiceNumber: invoice }); notified = true; } catch (e) { console.error('offline payment failed:', e.status); } }
  return R(200, { ok: true, dryRun: false, orderId, invoiceNumber: invoice, total: quote.total, cashierNotified: notified });
}
