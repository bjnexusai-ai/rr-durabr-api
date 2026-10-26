> **Update 26 Oct, late (task 8.1 on branch `rr-rista`):** `src/ristasale.js` sends paid and pay-at-pickup orders to Rista's Save sale (same request as `src/order.js`), wired in `index.js` behind `RISTA_PUSH_LIVE` (off). First run: a staffed test at MR with `RISTA_PUSH_LIVE=true` and `RISTA_PUSH_TEST=true` (orders say DO NOT PREPARE), only MR in `ONLINE_OUTLETS_LIVE` (task 8.6). Still open: Rista's online-payment call (8.3): until then paid sales carry a PAID-ONLINE tag and a DO NOT COLLECT note.
>
> **Update 26 Oct night (task 4.1a DONE on branch `rr-26oct`):** `src/index.js` now wires everything below; see the commit
> "4.1a". Still NOT connected: `pushToRista` (needs the Rista Sale adapter, 8.1; `src/order.js` `buildSale` is the starting
> point) and the owner alert channel (10.1; findings go to the Worker log as `OWNER ALERT`). Ordering stays closed until
> `ONLINE_ORDER_LIVE=true` and the secrets exist; the switch list is in the table below.

# How the new API files plug into `src/index.js` (for task 4.1a; nothing here is wired yet)

All files are NEW and not imported by anything, so adding them changes nothing. The final, exact `index.js` patch is written in
task 4.1a, after the builder sees `git diff src/index.js` (another session already gave a patch) and the `makeQuote` function.
Shape of the wiring (for review, NOT to paste blindly):

```js
import { createOrderingHandler } from './ordering.js';
import { makeSender } from './msg91.js';            // 5.1  OTP_PROVIDER=msg91|mock
import { loyaltyLookup } from './loyalty.js';        // 9.1b LOYALTY_PROVIDER=reelo|mock (lookup only)
import { payuVerify } from './payuverify.js';       // 7.3  server-to-server PayU check
import { makeOrderingQuote, withPaiseFields } from './quotemoney.js'; // 4.1a/4.5a exact paise
import { createHealthHandler } from './health.js';  // 10.8
import { housekeeping } from './housekeeping.js';   // 4.8 safe part
import { expireUnpaid } from './expiry.js';         // 7.4 close unpaid orders, PayU asked first
import { reconcilePayu } from './reconcile.js';     // 8.5 daily PayU check (once a day: a second cron, e.g. 02:00 IST)
import { makeRistaPusher } from './ristapush.js';   // 8.2-8.4, 8.7 Rista push + retries (sendSale adapter comes with 8.1)
// const rista = makeRistaPusher({ sendSale: /* Rista adapter, 8.1 */, alert: /* owner alert, 10.1 */ });

const ordering = createOrderingHandler({
  quote: makeOrderingQuote(/* (env, ristaCode, items) => existing makeQuote result in rupees: decided in 4.1a */),
  makeSender, loyaltyLookup, payuVerify,
  // pushToRista: rista.pushToRista   <- add ONLY when the Rista sendSale adapter exists (8.1)
});
const health = createHealthHandler();

export default {
  async fetch(request, env, ctx) {
    const h = await health(request, env); if (h) return h;
    const o = await ordering(request, env, ctx); if (o) return o;
    // ... existing routes unchanged. In the existing /api/quote route: return withPaiseFields(q, items) instead of q,
    //     so the checkout gets paise and the site cart keeps lines/subtotal/tax/total/allOk.
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(Promise.all([housekeeping(env.DB), expireUnpaid(env.DB, env, { payuVerify }) /* , rista.retryPushes(env) after 8.1 */])); }, // plus a cron trigger in wrangler.toml
};
```

## What each file needs before it does anything real
| File | Switch on with | Until then |
|---|---|---|
| `msg91.js` | `OTP_PROVIDER=msg91`, secrets `MSG91_AUTHKEY`, `MSG91_TEMPLATE_ID` (DLT approved) | no sender: OTP answers `provider_down` (mock only on staging with `ALLOW_MOCKS=true`) |
| `payuverify.js` | secrets `PAYU_KEY`, `PAYU_SALT`, `PAYU_MODE=test` then `live`; optional `PAYU_VERIFY_URL` | returns `unconfigured`: nothing is ever marked PAID |
| `loyalty.js` + `reelo.js` | `LOYALTY_PROVIDER=reelo`, `REELO_DOMAIN`, secrets `REELO_VENDOR_ID`, `REELO_<SN/MR/BH/PO/AT>_MERCHANT_ID`, `REELO_<..>_CUSTOMER_KEY` | `{available:false}`: checkout says rewards unavailable, ordering continues |
| `health.js` | secret `ADMIN_KEY` (32+ characters) for the self-check | `/api/health` works; self-check answers 404 |
| `quotemoney.js` | 4.1a: confirm field names against `makeQuote` | not used |
| `housekeeping.js` | a cron trigger (deploy session) | not used |
| `expiry.js` | the same cron trigger; `UNPAID_TIMEOUT_MIN` (default 30) | not used; with PayU not set up it never closes an order |
| `ristapush.js` | a `sendSale` adapter built from Rista's Sale and Payment models (8.1), and an owner alert channel (10.1) | not used: nothing reaches Rista |

## Tests (all on the real migrations through `testlib/d1shim.mjs`)
`test/housekeeping.test.mjs` 5, `test/rr-payuverify.test.mjs` 5, `test/rr-providers.test.mjs` 15, `test/rr-reelo.test.mjs` 10,
`test/rr-expiry.test.mjs` 6 (PayU asked first; paid/failed/unknown/pending/unreachable; young orders untouched; mismatch flagged),
`test/rr-ristapush.test.mjs` 8 (paid online -> one sale -> CONFIRMED; pay at pickup goes unpaid; unpaid online NEVER sent; 1/2/5/10 min retries then REFUND_NEEDED + one alert; recovery on retry; pay-at-pickup gives up with a call-the-customer alert; two runs send a try once; lost first try picked up),
`test/rr-wiring.test.mjs` 6 (the new files plugged into the REAL routes: SMS code, rewards balance, order from a rupee quote,
PayU success confirmed by the server check = PAID; PayU check says failure = stays unpaid; amount mismatch = MISMATCH;
a quote one paisa off = refused before any order is written; pay at pickup under Rs 1000; no SMS without Turnstile).
Builder run, 26 Oct: 149 of 149 with rr-api-core and rr-routes (clock patch applied). Four planted bugs were each caught.
Expected in the repo: 132 + 55 = 187 pass, fail 0.

## Sources checked for the provider calls (26 Oct 2026)
- PayU verify_payment: https://docs.payu.in/docs/verify_payment_api (test host, form POST, hash `sha512(key|command|var1|salt)`, reply fields). Live host taken from PayU's long-used address; override with `PAYU_VERIFY_URL` if PayU gives another.
- MSG91 OTP v5: MSG91's API reference via https://www.withone.ai/knowledge/msg91/conn_mod_def%3A%3AGNWEPXHtmnI%3A%3Aq4wrVJxbTKqbNHKe5PcQVw and the msg91-v5 package page (https://npmjs.org/package/msg91-v5). Confirm in the MSG91 panel when the account exists.

## Added v2.8b
- `reconcile.js`: `reconcilePayu(env.DB, env, { payuVerify, alert })` once a day (a second cron trigger, e.g. `30 20 * * *` UTC = 02:00 IST; in `scheduled`, check `event.cron`). `alert` is the owner alert of task 10.1; until it exists, pass `async (t) => console.log(t)`.
- `tools/patches/patch_status_ratelimit.py`: applied to `src/ordering.js` in INSTALL part B. The quote limit (60 per minute per IP) goes into the `/api/quote` handler in `index.js` with 4.1a, using `rateCheck` from `otp.js` with bucket `quote_ip`.
- `test/rr-payu-cases.test.mjs`: task 7.5, no wiring needed.

