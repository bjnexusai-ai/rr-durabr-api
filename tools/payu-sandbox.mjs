// Local PayU TEST sandbox. Reads .dev.vars, never prints key, salt or hash.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { buildPayuFields, verifyPayuResponse, responseHashString, sha512hex } from '../src/payu.js';
import { payuVerify } from '../src/payuverify.js';

const env = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const { PAYU_KEY: key, PAYU_SALT: salt } = env;
env.PAYU_MODE = 'test';
const BASE = `https://${process.env.CODESPACE_NAME}-3000.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
const orders = new Map();
const html = (b) => `<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px sans-serif;padding:24px">${b}`;
const readBody = (req) => new Promise((r) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => r(Object.fromEntries(new URLSearchParams(d))));
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  const send = (code, s, type = 'text/html') => { res.writeHead(code, { 'content-type': type }); res.end(s); };
  try {
    if (req.method === 'GET' && u.pathname === '/') {
      const paise = Number(u.searchParams.get('paise') || 1000);
      const txnid = 'TEST' + Date.now();
      orders.set(txnid, paise);
      const { action, fields } = await buildPayuFields({
        key, salt, mode: 'test', order: { id: txnid, totalPaise: paise },
        customer: { name: 'Test User', email: 'test@example.com', phone: '9999999999' },
        urls: { surl: BASE + '/surl', furl: BASE + '/furl' },
      });
      const inputs = Object.entries(fields)
        .map(([k, v]) => `<input type=hidden name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('');
      console.log('NEW PAYMENT', txnid, 'paise', paise);
      return send(200, html(`<h3>PayU TEST payment: ${txnid}</h3><form method=POST action="${action}">${inputs}<button style="font-size:18px;padding:10px 20px">Pay Rs ${(paise / 100).toFixed(2)}</button></form>`));
    }
    if (req.method === 'POST' && (u.pathname === '/surl' || u.pathname === '/furl')) {
      const p = await readBody(req);
      const paise = orders.get(p.txnid);
      const vr = paise === undefined
        ? { ok: false, code: 'unknown_txnid' }
        : await verifyPayuResponse(p, { key, salt, expectedTxnid: p.txnid, expectedAmountPaise: paise });
      const sv = await payuVerify(env, p.txnid);
      const out = {
        route: u.pathname, posted_status: p.status, txnid: p.txnid, amount: p.amount,
        mihpayid: p.mihpayid, error: p.error_Message || p.error,
        responseHash: vr, serverVerify: { status: sv.status, amountPaise: sv.amountPaise },
      };
      console.log('CALLBACK', JSON.stringify(out));
      return send(200, html(`<pre>${JSON.stringify(out, null, 2)}</pre><a href="/">Try another</a>`));
    }
    if (u.pathname === '/selftest') {
      const base = { key, txnid: 'T1', amount: '10.00', productinfo: 'x', firstname: 'a', email: 'a@b.c', status: 'success', mihpayid: '1' };
      const good = { ...base, hash: await sha512hex(responseHashString({ key, salt, ...base })) };
      const ok = { key, salt, expectedTxnid: 'T1', expectedAmountPaise: 1000 };
      const r = {
        good: await verifyPayuResponse(good, ok),
        tampered_amount: await verifyPayuResponse({ ...good, amount: '1.00' }, ok),
        bad_hash: await verifyPayuResponse({ ...good, hash: '0'.repeat(128) }, ok),
        wrong_txn: await verifyPayuResponse(good, { ...ok, expectedTxnid: 'OTHER' }),
        wrong_amount: await verifyPayuResponse(good, { ...ok, expectedAmountPaise: 5000 }),
      };
      console.log('SELFTEST', JSON.stringify(r));
      return send(200, JSON.stringify(r, null, 2), 'application/json');
    }
    send(404, 'not found');
  } catch (e) {
    console.error('ERR', String(e && e.message).slice(0, 200));
    send(500, 'error');
  }
}).listen(3000, () => console.log('Sandbox on', BASE));