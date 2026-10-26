// node --test test/rr-statuslimit.test.mjs   (task 10.1a status half; needs tools/patches/patch_status_ratelimit.py applied)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newDb, SKIP } from './_dbroutes.mjs';
import { createOrderingHandler } from '../src/ordering.js';
import { createOrder, newStatusToken } from '../src/orderstore.js';

const patched = readFileSync(new URL('../src/ordering.js', import.meta.url), 'utf8').includes("bucket: 'status_order'");
const NOW = new Date('2026-10-24T09:00:00Z');
let clock = NOW;
const env = (db) => ({ DB: db, ONLINE_ORDER_LIVE: 'true', ONLINE_OUTLETS_LIVE: 'moghalrajpuram', TOKEN_SIGNING_KEY: 'k'.repeat(40), OTP_HASH_SECRET: 'o'.repeat(40),
  PAYMENT_PROVIDER: 'payu', API_ORIGIN: 'https://api.example', SITE_ORIGIN: 'https://site.example', ALLOWED_ORIGINS: 'https://site.example' });
async function setup() {
  const db = newDb(); const t = await newStatusToken();
  const r = await createOrder(db, { branch: 'moghalrajpuram', slotAt: '2026-10-24T09:30:00.000Z', method: 'payu', items: [{ ristaItemId: 'r1', name: 'Biryani', qty: 1, unitPaise: 30000 }],
    subtotalPaise: 30000, taxPaise: 1500, totalPaise: 31500, phone: '9876543210', name: 'Asha', statusTokenHash: t.hash, consents: [{ kind: 'terms', granted: true, wordingVersion: 'v1' }], maxOpen: 9 });
  const h = createOrderingHandler({ now: () => clock });
  const get = (ip = '10.0.0.1', id = r.orderId) => h(new Request(`https://api.example/api/order/status?id=${id}&t=${t.token}`, { headers: { 'CF-Connecting-IP': ip, Origin: 'https://site.example' } }), env(db), { waitUntil() {} });
  return { db, get };
}

describe('order status rate limit (10.1a)', { skip: SKIP || (!patched && 'apply tools/patches/patch_status_ratelimit.py first') }, () => {
  test('150 checks of one order in 10 minutes are fine; the 151st gets 429 with Retry-After; 10 minutes later it works again', async () => {
    clock = NOW; const { get } = await setup();
    for (let i = 0; i < 150; i++) assert.equal((await get()).status, 200, `check ${i + 1}`);
    const r = await get();
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('Retry-After')) > 0);
    assert.equal((await r.json()).error.code, 'rate_limited');
    clock = new Date(NOW.getTime() + 601000);
    assert.equal((await get()).status, 200);
  });
  test('a broken limit table never hides the order', async () => {
    clock = NOW; const { db, get } = await setup();
    await db.prepare('DROP TABLE rate_events').run();
    assert.equal((await get()).status, 200);
  });
});
