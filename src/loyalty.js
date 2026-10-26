// RR Durbar API: rewards balance lookup for the checkout (plan task 9.1b, LOOKUP ONLY). New file, not wired.
// Contract with src/ordering.js: deps.loyaltyLookup(env, { phone, branch }) -> { available, member, balance, rewardsCount }.
// Uses src/reelo.js (the Reelo adapter written 23 Oct from Reelo's docs). Earning (Capture Bill) is NOT here: it waits for
// the owner's answer to R5 (are bills already sent to Reelo by the POS?) so points are never credited twice.
//
// Vars: LOYALTY_PROVIDER = reelo | mock (mock only with ALLOW_MOCKS=true), REELO_DOMAIN (Reelo's API host, from Reelo).
// Secrets (Worker secrets, never in code): REELO_VENDOR_ID, and per ordering outlet REELO_<CODE>_MERCHANT_ID and
// REELO_<CODE>_CUSTOMER_KEY where <CODE> is the Rista code: SN, MR, BH, PO, AT (Patamatalanka is not orderable).
import { createReelo } from './reelo.js';

const SLUG_TO_CODE = { singhnagar: 'SN', moghalrajpuram: 'MR', bhavanipuram: 'BH', poranki: 'PO', autonagar: 'AT' };
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

export function reeloConfig(env) {
  const branches = {};
  for (const [slug, code] of Object.entries(SLUG_TO_CODE)) {
    const merchantId = env[`REELO_${code}_MERCHANT_ID`], customerKey = env[`REELO_${code}_CUSTOMER_KEY`];
    if (merchantId && customerKey) branches[slug] = { merchantId, customerKey };
  }
  return { domain: env.REELO_DOMAIN || '', vendorId: env.REELO_VENDOR_ID || '', branches };
}

export function makeLoyaltyLookup({ fetchImpl } = {}) {
  return async function loyaltyLookup(env, { phone, branch }) {
    const p = String((env && env.LOYALTY_PROVIDER) || '').toLowerCase();
    if (p === 'mock') {
      if (!truthy(env.ALLOW_MOCKS)) return { available: false };
      return String(phone).endsWith('0001') ? { available: true, member: true, balance: 240, rewardsCount: 1 } : { available: true, member: false, balance: 0, rewardsCount: 0 };
    }
    if (p !== 'reelo') return { available: false };
    const reelo = createReelo({ ...reeloConfig(env), ...(fetchImpl ? { fetchImpl } : {}) });
    try {
      const r = await reelo.lookup(String(branch || '').toLowerCase(), phone);
      return { available: true, member: r.balance > 0 ? true : null, balance: Math.max(0, Math.floor(r.balance)), rewardsCount: r.coupons.length };
    } catch (e) {
      // A number Reelo has never seen comes back as a refusal ("not found"): that is a real answer, balance 0.
      if (e && e.code === 'rejected' && /not\s*found/i.test(String(e.message))) return { available: true, member: false, balance: 0, rewardsCount: 0 };
      return { available: false };
    }
  };
}

export const loyaltyLookup = makeLoyaltyLookup();
