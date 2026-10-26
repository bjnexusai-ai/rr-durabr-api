// RR Durbar API: OTP SMS sender (plan task 5.1). New file, not wired.
// Contract with src/ordering.js: deps.makeSender(env) -> { send(phone10, code) -> { ok } } or null (null = provider_down).
// Our server makes and checks the code (src/otp.js); MSG91 only delivers the SMS.
//
// MSG91 OTP API v5 (checked 26 Oct 2026 against MSG91's published API reference; confirm in the MSG91 panel when the account exists):
//   POST https://control.msg91.com/api/v5/otp?template_id=..&mobile=91XXXXXXXXXX&otp=..&otp_length=6&otp_expiry=5&realTimeResponse=1
//   header authkey: <MSG91_AUTHKEY>;  JSON body = the template's variables (default name "OTP")
//   reply { "type": "success", "request_id": ... }  or  { "type": "error", "message": ... }  (errors can come with HTTP 200)
// The DLT-approved template must contain the code variable. For Android autofill its LAST line should be "@rrdurbar.com #<code>"
// (owner adds this to the DLT template; nothing to change here).
// Secrets: MSG91_AUTHKEY, MSG91_TEMPLATE_ID. Optional var: MSG91_OTP_VAR (template variable name, default OTP).
// Var OTP_PROVIDER = msg91 | mock. mock works only with ALLOW_MOCKS=true (staging), same rule as src/ordering.js.

const URL_V5 = 'https://control.msg91.com/api/v5/otp';
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
export const mask = (p) => `${String(p).slice(0, 2)}xxxxxx${String(p).slice(-2)}`;

export function msg91Sender(env, { fetchImpl = fetch, timeoutMs = 10000, expiryMinutes = 5 } = {}) {
  const authkey = env && env.MSG91_AUTHKEY, template = env && env.MSG91_TEMPLATE_ID;
  if (!authkey || !template) return null;
  return {
    async send(phone, code) {
      if (!/^[6-9]\d{9}$/.test(String(phone)) || !/^\d{4,9}$/.test(String(code))) return { ok: false, error: 'bad_input' };
      const q = new URLSearchParams({ template_id: template, mobile: `91${phone}`, otp: String(code), otp_length: String(String(code).length), otp_expiry: String(expiryMinutes), realTimeResponse: '1' });
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      let res, j = null;
      try {
        res = await fetchImpl(`${URL_V5}?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', authkey }, body: JSON.stringify({ [env.MSG91_OTP_VAR || 'OTP']: String(code) }), signal: ctl ? ctl.signal : undefined });
        try { j = await res.json(); } catch { j = null; }
      } catch {
        console.error('msg91 unreachable', mask(phone));
        return { ok: false, error: 'unreachable' };
      } finally { if (timer) clearTimeout(timer); }
      if (res.ok && j && j.type === 'success') return { ok: true, requestId: j.request_id ? String(j.request_id) : null };
      console.error('msg91 refused', mask(phone), res.status, j && j.type, String((j && j.message) || '').slice(0, 80));
      return { ok: false, error: 'refused' };
    },
  };
}

export function makeSender(env, opts = {}) {
  const p = String((env && env.OTP_PROVIDER) || '').toLowerCase();
  if (p === 'msg91') return msg91Sender(env, opts);
  if (p === 'mock') {
    if (!truthy(env.ALLOW_MOCKS)) return null;
    return { async send(phone, code) { console.log('[mock-otp]', mask(phone), code); return { ok: true, mock: true }; } };
  }
  return null;
}
