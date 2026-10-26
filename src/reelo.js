// RR Durbar: Reelo POS integration adapter (server side only; runs in the API Worker, NEVER in the browser).
// Built from Reelo's POS Integration docs (sections received 23 Oct 2026): Get customer loyalty details,
// Authenticate redemption (send_otp), Redeem Coupon, Redeem Points.
// NOT built because the docs have not been received: Capture Bill, Edit Bill, Revert Points, Sale Return, Push Menu, Push payment types.
// Those methods throw ReeloError('not_documented') on purpose. Do not guess their shapes.
//
// config = { domain, vendorId, branches: { <branchCode>: { merchantId, customerKey } }, timeoutMs?, fetchImpl?, authPhoneField? }
// Secrets (merchantId, customerKey) come from Worker secrets or env, never from source or the browser.

export class ReeloError extends Error {
  constructor(code, message, status) { super(message); this.name = 'ReeloError'; this.code = code; this.status = status || 0; }
}
// code: 'not_configured' | 'bad_phone' | 'down' | 'rejected' | 'bad_response' | 'not_documented'
// 'down' and 'bad_response' = show "Rewards unavailable, you can still order". 'rejected' = Reelo said no (wrong OTP, reward used, etc).

export function normalizePhone(input) {
  let d = String(input == null ? '' : input).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw new ReeloError('bad_phone', 'Enter a valid 10-digit mobile number.');
  return d;   // valid mobile number without any country code prefix (Reelo docs)
}

export function createReelo(config) {
  const cfg = Object.assign({ timeoutMs: 8000, authPhoneField: 'customer_mobile' }, config || {});
  const doFetch = cfg.fetchImpl || ((...a) => fetch(...a));

  function branch(code) {
    const b = cfg.branches && cfg.branches[code];
    if (!cfg.domain || !cfg.vendorId || !b || !b.merchantId || !b.customerKey)
      throw new ReeloError('not_configured', 'Rewards are not set up for this outlet.');
    return b;
  }
  const url = (path) => `${String(cfg.domain).replace(/\/+$/, '')}/v1/pos/integrations/${encodeURIComponent(cfg.vendorId)}${path}`;

  async function call(path, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    let res, text;
    try {
      res = await doFetch(url(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      text = await res.text();
    } catch (e) {
      throw new ReeloError('down', 'Reelo did not respond.');               // no URL, no body: nothing sensitive in the message
    } finally { clearTimeout(t); }
    let json = null;
    if (text && text.trim()) { try { json = JSON.parse(text); } catch (e) { if (res.ok) throw new ReeloError('bad_response', 'Reelo sent an unreadable answer.', res.status); } }
    if (res.status >= 500) throw new ReeloError('down', 'Reelo is having trouble.', res.status);
    if (!res.ok) throw new ReeloError('rejected', (json && (json.message || (json.response && json.response.message))) || 'Reelo refused the request.', res.status);
    // Reelo wraps results as { status_code, response }. A 200 HTTP with another status_code inside is a refusal.
    if (json && json.status_code && Number(json.status_code) !== 200)
      throw new ReeloError('rejected', (json.response && json.response.message) || json.message || 'Reelo refused the request.', Number(json.status_code));
    return json;   // may be null (Redeem Points returns no body)
  }

  const idFields = (outlet, phone) => {
    const b = branch(outlet), p = normalizePhone(phone);
    return { b, p, base: { customer_key: b.customerKey, merchant_id: b.merchantId } };
  };
  const phoneFields = (p) => cfg.authPhoneField === 'both' ? { customer_mobile: p, phone: p } : { [cfg.authPhoneField]: p };

  return {
    // POST /rewards/customer
    async lookup(outlet, phone, extra) {
      const { p, base } = idFields(outlet, phone);
      const body = Object.assign({}, base, { customer_mobile: Number(p), table_number: (extra && extra.tableNumber) || '', number_of_pepole: (extra && extra.people) || '' });  // field name spelled exactly as in the docs
      const j = await call('/rewards/customer', body);
      const r = j && j.response;
      if (!r || typeof r !== 'object') throw new ReeloError('bad_response', 'Reelo sent an unexpected answer.');
      return normalizeLoyalty(r);
    },
    // POST /points/authenticate  (Reelo texts an OTP to the customer). Give a couponCode (tier based) or points (cashback) or walletCredits (membership).
    async sendRedeemOtp(outlet, phone, what) {
      const { p, base } = idFields(outlet, phone);
      const w = what || {};
      if (!w.couponCode && !w.points && !w.walletCredits) throw new ReeloError('rejected', 'Choose a reward or points to redeem.');
      const body = Object.assign({}, base, phoneFields(p));
      if (w.couponCode) body.coupon_code = String(w.couponCode);
      if (w.points) body.points = String(w.points);
      if (w.walletCredits) body.wallet_credits = String(w.walletCredits);
      const j = await call('/points/authenticate', body);
      return { sent: true, pointsValue: j && j.response ? Number(j.response.points_value || 0) : 0 };
    },
    // POST /redeem/coupon. Consumes the reward immediately on success.
    async redeemCoupon(outlet, phone, couponCode, otp) {
      const { p, base } = idFields(outlet, phone);
      if (!couponCode || !/^\d{3,8}$/.test(String(otp || ''))) throw new ReeloError('rejected', 'Enter the code Reelo sent.');
      const j = await call('/redeem/coupon', Object.assign({}, base, { customer_mobile: p, coupon_code: String(couponCode), otp: String(otp) }));
      return { redeemed: true, message: (j && j.response && j.response.message) || 'Coupon redeemed.' };
    },
    // POST /redeem/points. Reelo returns NO body: success means a 2xx and nothing else, so always re-run lookup() to confirm the new balance.
    async redeemPoints(outlet, phone, points, otp, walletCredits) {
      const { p, base } = idFields(outlet, phone);
      if (!(Number(points) > 0) || !/^\d{3,8}$/.test(String(otp || ''))) throw new ReeloError('rejected', 'Enter points and the code Reelo sent.');
      const body = Object.assign({}, base, { customer_mobile: p, points: Number(points), otp: String(otp) });
      if (walletCredits) body.wallet_credits = String(walletCredits);
      await call('/redeem/points', body);
      return { redeemed: true, confirmWithLookup: true };
    },
    // Not documented yet. Deliberately not implemented.
    async captureBill()   { throw new ReeloError('not_documented', 'Capture Bill docs not received.'); },
    async editBill()      { throw new ReeloError('not_documented', 'Edit Bill docs not received.'); },
    async revertPoints()  { throw new ReeloError('not_documented', 'Revert Points docs not received.'); },
    async saleReturn()    { throw new ReeloError('not_documented', 'Sale Return docs not received.'); },
    async pushMenu()      { throw new ReeloError('not_documented', 'Push Menu docs not received.'); },
    async pushPaymentTypes() { throw new ReeloError('not_documented', 'Push payment types docs not received.'); }
  };
}

// Reelo response -> one stable shape for the checkout. Unknown fields are ignored, missing ones get safe defaults.
export function normalizeLoyalty(r) {
  const num = (v) => (v === '' || v == null || isNaN(Number(v))) ? 0 : Number(v);
  const m = r.membership || {};
  const cb = r.cashback_redemption || {};
  return {
    balance: num(r.loyalty_points),
    allowRedemptionToday: r.allow_redemption_today === true || r.allow_redemption_today === 'true',
    cashback: { active: cb.active === true || cb.active === 'true', percentage: num(cb.percentage), fixed: num(cb.fixed),
                minBill: num(r.min_bill_for_redemption), redeemablePoints: num(r.total_redeemable_points), capPercentOfBill: num(r.redemption_cap_on_max_bill_percentage) },
    membership: { active: m.active === true || m.active === 'true', type: m.type || '', walletCredits: num(m.wallet_credits),
                  minBill: num(m.min_bill_for_redemption_membership), redeemablePoints: num(m.total_redeemable_points_membership), capPercentOfBill: num(m.redemption_cap_on_max_bill_percentage_membership) },
    coupons: (Array.isArray(r.coupons) ? r.coupons : []).map((c) => {
      const extra = {}; (c.extra_fields || []).forEach((f) => { if (f && f.name) extra[f.name] = f.value; });
      return { code: String(c.coupon_code || ''), name: String(c.coupon_name || ''), on: c.discount_on === 'item' ? 'item' : 'bill',
               type: c.discount_type === 'fixed' ? 'fixed' : 'percentage', value: num(c.discount_value), maxDiscount: num(c.max_discount),
               minBill: num(c.min_bill_amount_for_redemption), special: c.special_offer === true, pointsCost: num(extra['Points Value']),
               rewardType: extra['Reward Type'] || '', products: (c.products || []).map((p) => ({ id: String(p._id), qty: num(p.quantity) || 1 })) };
    }).filter((c) => c.code)
  };
}
