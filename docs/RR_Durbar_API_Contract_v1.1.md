# RR Durbar ordering API: contract v1 (task 4.3)

Status: DRAFT for the `rr-durbar-api` Worker. Written 23 Oct 2026 from the master plan (sections 7, 4.x to 7.x) and the checkout prototype. The checkout page (`public/checkout/index.html`, live mode) conforms to this contract and is tested against a simulated server (see section 12).
Nothing here is implemented in the API repo yet (repo not received). Items marked **[TBC]** need a document or answer before coding.

---
## 1. Conventions
- Base path `/api`, same origin as the site. JSON in and out, UTF-8, `Content-Type: application/json`. Exceptions: PayU callback (form encoded), noted below.
- **Money: integer paise** in every API field (`totalPaise`). Never floats. PayU receives a string with 2 decimals built on the server.
- **Branch codes** are lowercase slugs: `singhnagar`, `moghalrajpuram`, `bhavanipuram`, `poranki`, `autonagar`. (Placeholders until the Rista branch mapping is confirmed. Patamatalanka is call-only and never orderable.)
- **Times** are ISO 8601 UTC strings. Outlets run on Asia/Kolkata; labels for display are built on the server.
- **Auth:** after OTP verification the client holds a signed `token` and sends `Authorization: Bearer <token>`. No cookies (so no CSRF surface). Token lifetime 30 minutes, bound to the phone number, carries a random `nonce` recorded in D1 (plan 5.3).
- **Idempotency:** `POST /checkout/start` requires header `Idempotency-Key` (UUID). Same key + same body returns the original response; same key + different body returns `409 idempotency_conflict`.
- **Order secret:** `checkout/start` returns a `statusToken` (128-bit random, stored only as a hash). `GET /order/status` needs `id` and `t`, so order ids cannot be enumerated.
- **CORS:** allow only the site origins (`https://rrdurbar.com` and the preview/live Worker hostnames). No wildcard.
- **Errors:** HTTP status plus body `{ "error": { "code": "...", "message": "safe text for the customer", "field": "optional" } }`. Messages never contain provider text, keys, URLs or stack traces. Codes in section 9.

## 2. Config and flags (task 4.3)
Environment (Worker vars, not secrets): `ONLINE_ORDER_LIVE` (master switch), `ONLINE_OUTLETS_LIVE` (list of branch codes), `COD_LIVE=true`, `COD_MAX_TOTAL=1000` (rupees, total INCLUDING taxes, inclusive: Rs 1000.00 allows pay at pickup, Rs 1000.01 does not), `COD_OUTLETS` (list), `PAYMENT_PROVIDER=payu|mock`, `LOYALTY_PROVIDER=reelo|mock`, `OTP_PROVIDER=msg91|mock`, `TERMS_VERSION` (consent wording id). Per-outlet config by branch code: hours, `minPrepMinutes`, `slotMinutes`, `maxOpenOrdersPerPhone=2`.
Secrets (`wrangler secret put`, hidden prompt, never in chat or repo): `PAYU_KEY`, `PAYU_SALT`, `MSG91_AUTHKEY`, `TURNSTILE_SECRET`, `TOKEN_SIGNING_KEY`, `RISTA_*`, `REELO_*` (per branch merchant id and customer key, vendor id).
When `ONLINE_ORDER_LIVE=false` every ordering endpoint except `config` returns `503 ordering_closed`.

## 3. Endpoints

### 3.1 GET /api/config
Public. Tells the site what is open. No secrets.
```json
{ "orderingOpen": true, "termsVersion": "2026-10-22-v1", "codMaxPaise": 100000,
  "branches": [ { "code": "poranki", "name": "Poranki", "open": true, "codAllowed": true, "hours": { "open": "11:00", "close": "23:30" }, "minPrepMinutes": 30 } ] }
```
Only branches in `ONLINE_OUTLETS_LIVE` are listed with `open: true`. The checkout builds its outlet list from this (prototype currently has a static list: switch when the API exists).

### 3.2 GET /api/slots?branch=poranki
```json
{ "slots": [ { "id": "2026-10-23T08:15:00.000Z", "label": "1:45 pm" } ] }
```
Rules: inside outlet hours, not before now + `minPrepMinutes`, step `slotMinutes`, max 8 returned, none when the outlet is closed (`slots: []` and `outletClosed: true`). `slot.id` is what `checkout/start` receives.

### 3.3 POST /api/quote
Server prices from Rista (Website channel). Browser prices are never used. Callable as an internal function from `checkout/start` (plan 4.5).
Request: `{ "branch": "poranki", "items": [ { "id": "<rista item id>", "qty": 2 } ] }` (qty 1 to 20, up to 30 lines).
```json
{ "branch": "poranki",
  "items": [ { "id": "r123", "name": "Chicken Dum Biryani (Regular)", "displayName": "Chicken Dum Biryani (Regular)", "qty": 1, "unitPaise": 34900, "linePaise": 34900 } ],
  "subtotalPaise": 64800, "taxPaise": 3240, "totalPaise": 68040, "earnPoints": 648, "codAllowed": true }
```
`name` is the Rista name (what is ordered); `displayName` is the card caption used on the site (task 1.3) when different. Errors: `item_unavailable` (sold out or unknown, with `field` = item id; the cart must remove it), `provider_down` (Rista). The total must equal what Rista invoices including taxes and charges (verify one order per outlet, plan 4.5). `earnPoints` is informational and only shown after Reelo rules are confirmed [TBC, see Reelo spec].

### 3.4 POST /api/otp/send
Request: `{ "phone": "9876543210", "purpose": "checkout", "turnstileToken": "..." }`. Phone is 10 digits, no country code, starts 6 to 9. Turnstile is REQUIRED at launch (SMS pumping defence, plan 5.1).
Response: `{ "sent": true, "resendAfterSeconds": 30 }`.
Limits: 3 sends per phone per 10 minutes, 10 per IP per hour; breach returns `429 rate_limited` with `retryAfterSeconds`. Code: 6 digits, valid 5 minutes, stored hashed in KV with the attempt counter (KV is not atomic: the 5-attempt cap is also enforced in D1 or a Durable Object). With `OTP_PROVIDER=mock` the code is logged, never sent.

### 3.5 POST /api/otp/verify
Request: `{ "phone": "9876543210", "code": "123456" }`.
Response: `{ "token": "<signed>", "expiresInSeconds": 1800 }`. Errors: `otp_wrong` (attempts left in message), `otp_expired`, `otp_locked` (5 failures, request a new code).

### 3.6 POST /api/loyalty/lookup   (Bearer)
Request: `{ "branch": "poranki" }` (phone comes from the token). Normalised from Reelo (see `RR_Durbar_Reelo_Spec.md`):
```json
{ "available": true, "member": null, "balance": 240, "earnPoints": 648, "rewardsCount": 3 }
```
`member` is `true`, `false` or `null` (unknown: Reelo has no such field [TBC R4]). If Reelo is down: HTTP 200 `{ "available": false }` (ordering continues, no points shown, plan 6.2), never an error that blocks checkout. Redemption endpoints are NOT in v1 (Reelo spec R1).

### 3.7 POST /api/checkout/start   (Bearer, Idempotency-Key)
Request:
```json
{ "branch": "poranki", "slotId": "2026-10-23T08:15:00.000Z", "method": "payu",
  "items": [ { "id": "r123", "qty": 1 } ],
  "customer": { "name": "Asha", "email": "" },
  "consent": { "terms": true, "marketing": false, "version": "2026-10-22-v1" } }
```
Server steps (in this order): ordering open and branch live; token valid and nonce unused for a new order; slot valid; **re-price via the quote function**; method allowed (`cod` only when `totalPaise <= COD_MAX_TOTAL*100`, branch in `COD_OUTLETS`; otherwise `400 cod_not_allowed`); open-order cap (`too_many_open_orders`, max 2 per phone, counted from D1); upsert customer; store consent (terms and marketing separately, timestamp, wording version, IP hash); create order.
Response for `payu`: state `PAYMENT_PENDING`.
```json
{ "orderId": "RR-100234", "statusToken": "<random>", "state": "PAYMENT_PENDING", "totalPaise": 68040,
  "payment": { "type": "payu", "action": "https://secure.payu.in/_payment", "method": "POST",
               "fields": { "key": "...", "txnid": "RR-100234", "amount": "680.40", "productinfo": "RR Durbar pickup order", "firstname": "Asha", "email": "...", "phone": "9876543210", "surl": "https://rrdurbar.com/api/payu/callback", "furl": "https://rrdurbar.com/api/payu/callback", "hash": "<sha512>" } } }
```
The browser builds a hidden form from `payment` and submits it (a redirect cannot carry a POST). The page submits only to `https://secure.payu.in/` or `https://test.payu.in/`; any other `action` is refused and nothing is sent. The hash and salt are computed on the server only; the salt is never sent. `txnid` = order id. Field order and the hash formula must be checked against PayU's current docs [TBC 7.2]. PayU requires an email: if the guest left it empty the server uses a placeholder address only if PayU accepts one, otherwise the checkout must collect an email on the payment step [TBC 7.2].
Response for `cod`: `{ "orderId", "statusToken", "state": "CONFIRMED", "totalPaise", "payment": null }` once the Rista push succeeded; if the push is still retrying the state is `CREATED` or `PUSHED_TO_RISTA` and the client polls status. Never `CONFIRMED` before Rista accepted it.

### 3.8 POST /api/payu/callback  (form encoded, from PayU) and POST /api/payu/webhook
Both: verify the response hash (reverse hash with salt); call PayU's verify-payment API with the txnid and trust that, not the posted body; compare the confirmed amount to the order's `totalPaise` (mismatch: flag `REFUND_NEEDED`, do not push); then compare-and-set `PAYMENT_PENDING -> PAID` in D1. Callback and webhook can both arrive, any order, more than once: the second one changes nothing and returns 200. After a successful callback respond `303` to `https://rrdurbar.com/checkout/?order=<id>&t=<statusToken>` (the secret in the URL is the status token only). Failure or cancel: `PAYMENT_PENDING -> PAYMENT_FAILED` and 303 to `/checkout/?order=<id>&t=<token>`.

### 3.9 GET /api/order/status?id=RR-100234&t=<statusToken>
```json
{ "orderId": "RR-100234", "state": "CONFIRMED", "method": "payu", "totalPaise": 68040,
  "branch": "poranki", "branchName": "Poranki", "slotLabel": "1:45 pm", "earnPoints": 648 }
```
Client treats only `CONFIRMED` as success (pay at pickup too). `PAYMENT_FAILED` and `EXPIRED` show the failure page. Anything else keeps polling (1.5 s, up to 30 s, then a "we could not confirm yet, check Track Order" message). Wrong `t`: `404 not_found` (same as unknown id).

### 3.10 Forms  POST /api/forms/contact, /api/forms/catering
Out of scope for the checkout; same conventions, Turnstile required, rate limited. Contract to be written with task 3.x.

### 3.11 Scheduled job (cron, every minute)
Expire `PAYMENT_PENDING` older than 20 minutes (verify with PayU first: an order that was paid must not be expired) to `EXPIRED`; retry `PUSH_FAILED` pushes (1, 2, 5, 10 minutes) then `REFUND_NEEDED` plus alert to the owner; reconcile paid-not-pushed orders; purge expired OTP and nonce rows.

## 4. State machine
| From | To | Trigger | Notes |
|---|---|---|---|
| (new) | CREATED | checkout/start (cod) | |
| (new) | PAYMENT_PENDING | checkout/start (payu) | |
| PAYMENT_PENDING | PAID | verified callback or webhook | amount must match |
| PAYMENT_PENDING | PAYMENT_FAILED | failure or cancel callback | |
| PAYMENT_PENDING | EXPIRED | cron, after PayU says not paid | |
| PAID / CREATED | PUSHED_TO_RISTA | Rista accepts the order | |
| PAID / CREATED | PUSH_FAILED | Rista error | cron retries |
| PUSH_FAILED | PUSHED_TO_RISTA | retry ok | |
| PUSH_FAILED (payu) | REFUND_NEEDED | retries exhausted | owner alert |
| PUSH_FAILED (cod) | CANCELLED | retries exhausted | owner alert, customer told |
| PAYMENT_FAILED / EXPIRED | REFUND_NEEDED | PayU reports money captured | owner alert (added 24 Oct) |
| REFUND_NEEDED | REFUNDED | owner marks refund done | terminal (added 24 Oct) |
| PUSHED_TO_RISTA | CONFIRMED | immediately after accept | customer-visible success |
Every change is `UPDATE orders SET state=?, version=version+1 WHERE id=? AND state=? ` and counts affected rows; zero rows means someone else already moved it (do nothing). Every change writes a row to `events` (from, to, actor, time, note). Online orders reach Rista only after `PAID`. Pay-at-pickup orders reach Rista unpaid (owner decision, total <= Rs 1000 incl. taxes). Loyalty points are earned only after `PAID` (online) or after counter settlement (pay at pickup, D8; no points on pay at pickup in v1 if Rista cannot signal settlement).

## 5. Data model (D1)
Implemented as `migrations/0001_schema.sql` and `0002_guards.sql` (22 tests). Tables: `customers`, `consents` (append-only), `orders` (paise, `version`, `status_token_hash`, `last_actor`, `last_note`, `charges_paise`), `order_items`, `payments` (one SUCCESS per order, `txnid` unique), `rista_pushes`, `events` (append-only, written by trigger), `idempotency_keys` (key, request_hash, order_id, response_json), `otp_challenges` (attempt cap in the table), `otp_nonces` (claimed atomically), `rate_events` (exact limits), `loyalty_events` (earn only, `UNIQUE(order_id, kind)`). KV is used only for short-lived caches, never for counters that must be exact.

## 6. Money rules (never break)
1. Server price only. Confirmed amount must equal `totalPaise` or flag and do not push.
2. Callback and webhook change state once (compare-and-set).
3. txnid = order id.
4. Paid but Rista down: auto retry, then `REFUND_NEEDED` and alert.
5. Never show or create a paid-looking order if PayU, Reelo or Rista is down.
6. The browser's payment choice is never trusted.

## 7. Security
HTTPS only; secrets only as Worker secrets; Turnstile on OTP send and forms; per-phone and per-IP limits (section 3.4, plus quote 60/min/IP, checkout/start 5 per 10 minutes per phone); PII (phone, email) masked in logs (`98xxxxx210`); PayU salt, Reelo keys and Rista tokens never leave the Worker; consent stored with wording version; privacy policy must name PayU, MSG91, Reelo and Rista as processors; retention policy to be set by the owner.

## 8. Checkout page conformance (live mode)
Done in `rr-6b` (checkout only; mock mode unchanged): branch codes instead of "outlet"; `GET /slots?branch=` (the old call dropped its query string); paise to rupees conversion; `Authorization: Bearer`; `Idempotency-Key` per placement attempt; PayU form post instead of redirect; return handling for `/checkout/?order=&t=`; status with `t`; loyalty `available:false` tolerated. Still to do when the API exists: Turnstile widget on the phone step, outlet list from `/config`, cart handoff from the site cart (`rr_cart_v2`).

## 9. Error codes
`ordering_closed` 503 · `branch_closed` 409 · `slot_invalid` 409 · `item_unavailable` 409 · `quote_mismatch` 409 · `cod_not_allowed` 400 · `too_many_open_orders` 429 · `rate_limited` 429 · `otp_wrong` 400 · `otp_expired` 400 · `otp_locked` 429 · `token_invalid` 401 · `idempotency_conflict` 409 · `bad_request` 400 · `not_found` 404 · `provider_down` 503 (Rista, PayU, MSG91) · `internal` 500. Customer-safe message always; provider detail only in server logs.

## 10. Test matrix (from plan section 11)
Rs 1000.00 offers both methods; Rs 1000.01 offers PayU only; forced `cod` above Rs 1000 rejected by the server; open-order cap of 2; guest with only a phone can order; sign-up by OTP; wrong, expired and locked OTP; SMS rate limits; slot rules and closed outlet; sold-out item between cart and start; quote equals Rista invoice at 3 outlets; PayU success, failure, cancel, closed tab, duplicate callback, duplicate webhook, amount mismatch; Rista down after payment (retry, then `REFUND_NEEDED`); Reelo down (order still works); idempotent retry of `start`; every state change writes an event.

## 11. Open items [TBC]
PayU hash field order and verify API (7.2); PayU email requirement for guests; Rista item id and tax fields and the real branch codes (4.5); Reelo rules, Capture Bill, double-credit risk (Reelo spec R1 to R5); MSG91 DLT template (5.1); owner's retention policy; whether pay-at-pickup settlement can be signalled from Rista (D8).

## 12. How the checkout page was verified against this contract
`tests/cotest_live.js` serves the page with `LIVE:true` and a simulated API (browser request interception) that REJECTS contract violations and records them. 21 checks pass (23 Oct 2026): slots are `GET` with `?branch=`; quote bodies carry `branch` and only `{id, qty}` items (no prices, no `outlet`); `otp/send` has `purpose` and a `turnstileToken` field and no Authorization header; `loyalty/lookup` and `checkout/start` carry `Authorization: Bearer` and a body without phone or token; `checkout/start` carries a UUID `Idempotency-Key` that is REUSED when the same attempt is retried; consent has terms, a boolean marketing flag and the wording version; paise are shown as rupees (68040 shows Rs 680.40); PayU gets a POSTed form with hash, txnid and amount; the return URL `/checkout/?order=&t=` is polled with `id` and `t` until `CONFIRMED` and shows outlet and slot from the status response; `PAYMENT_FAILED` shows the failure page and Try again restarts at the outlet step with the cart kept; `provider_down`, `cod_not_allowed` and `available:false` show safe messages; a hostile payment `action` is refused. `tests/cotest.js` is the same flow on the built-in mock (24 checks). Run: `node tests/cotest_live.js public/checkout/index.html` (needs Playwright). The simulated server in that file is an executable form of this contract: the real API must answer the same way.

Not covered by these tests (needs the real API): signature checks, PayU hash, Rista and Reelo behaviour, rate limits, D1 compare-and-set, the cron job.
