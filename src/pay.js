// Task 7.0: payment method rule. Pure functions, no I/O.
// Rule (owner decision D9): total INCLUDING taxes at or below Rs 1000.00 -> payu or cod (pay at pickup). Above -> payu only.
// Rs 1000.00 exactly = 100000 paise = both. Rs 1000.01 = 100001 paise = payu only.
// The database also refuses cod above 100000 paise (migration 0001). Raising the limit needs a new migration.
export const DB_COD_CEILING_PAISE = 100000;

export function isPaise(n) { return Number.isSafeInteger(n) && n >= 0; }

// COD_MAX_TOTAL is a Worker var in RUPEES (contract section 2), e.g. "1000". Never above the database ceiling. Bad value -> 100000.
export function codMaxPaiseFromEnv(env) {
  const raw = env && env.COD_MAX_TOTAL;
  if (raw === undefined || raw === null || raw === '') return DB_COD_CEILING_PAISE;
  const rupees = Number(raw);
  if (!Number.isFinite(rupees) || rupees < 0) return DB_COD_CEILING_PAISE;
  return Math.min(Math.round(rupees * 100), DB_COD_CEILING_PAISE);
}

export function paymentOptions(totalPaise, { codMaxPaise = DB_COD_CEILING_PAISE, codAllowedForBranch = true } = {}) {
  if (!isPaise(totalPaise) || totalPaise <= 0) throw new TypeError('totalPaise must be a positive integer');
  const options = ['payu'];
  if (codAllowedForBranch && totalPaise <= Math.min(codMaxPaise, DB_COD_CEILING_PAISE)) options.push('cod');
  return options;
}

// The browser's choice is never trusted: call this with the SERVER total.
export function checkMethod(method, totalPaise, opts) {
  if (method !== 'payu' && method !== 'cod') return { ok: false, code: 'bad_method' };
  return paymentOptions(totalPaise, opts).includes(method) ? { ok: true } : { ok: false, code: 'method_not_allowed' };
}

export function paiseToRupeeString(paise) {
  if (!isPaise(paise)) throw new TypeError('paise must be a non-negative integer');
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}
