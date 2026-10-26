# API contract v1.2: additions to v1.1 (26 Oct 2026, builder). Nothing in v1.1 is removed or renamed.
Merge into `RR_Durbar_API_Contract_v1.1.md` (as v1.2) when the owner confirms decision 0.8.

## New endpoints
- `GET /api/health` (public): `{ "ok": true, "ordering": { "open": false, "outlets": [] } }`. No configuration detail.
- `GET /api/admin/selfcheck` (header `x-admin-key` = Worker secret `ADMIN_KEY`, 32+ characters; anything else answers 404):
  `{ ok, ordering, bindings: { DB, DBQuery, KV }, providers: { otp, payment, payuMode, loyalty, mocksAllowed }, missing: ["NAME", ...] }`.
  Lists NAMES of missing vars and secrets only, never values.

## Changed response (backwards compatible)
- `POST /api/quote` keeps its current rupee fields for the site cart (`lines`, `subtotal`, `tax`, `total`, `allOk`) and ADDS the
  v1.1 paise fields (`items[].unitPaise`, `subtotalPaise`, `taxPaise`, `chargesPaise`, `totalPaise`) plus `paiseOk`.
  `paiseOk: false` means the rupee parts did not add up exactly; the checkout then refuses to continue (no rounding, ever).

## New Worker variables and secrets (names only)
| Name | Kind | Meaning | Default |
|---|---|---|---|
| `UNPAID_TIMEOUT_MIN` | var | minutes before an unpaid online order is checked with PayU and closed | 30 (min 15, max 240) |
| `PAYU_VERIFY_URL` | var | override PayU's verify_payment address | test or live host by `PAYU_MODE` |
| `MSG91_OTP_VAR` | var | name of the code variable in the MSG91 template | `OTP` |
| `LOYALTY_PROVIDER` | var | `reelo` or `mock` (mock only with `ALLOW_MOCKS=true`) | off |
| `REELO_DOMAIN` | var | Reelo API host | none |
| `REELO_VENDOR_ID` | secret | from Reelo | none |
| `REELO_<SN/MR/BH/PO/AT>_MERCHANT_ID`, `REELO_<..>_CUSTOMER_KEY` | secrets | per ordering outlet | none |
| `ADMIN_KEY` | secret | opens the self-check | none (self-check closed) |

## Scheduled job (contract 3.11), as built
Every run: `housekeeping` (old OTP, nonce, rate and idempotency rows) and `expireUnpaid` (PAYMENT_PENDING older than
`UNPAID_TIMEOUT_MIN`: PayU is asked first; paid -> PAID, failed -> PAYMENT_FAILED, unknown -> EXPIRED, pending or unreachable -> left).
Rista retries (`ristapush.js`: 1, 2, 5, 10 minutes, then REFUND_NEEDED for paid orders + owner alert) run from the same job once
the Rista adapter exists (8.1). Daily PayU/Rista reconciliation (8.5) comes after that.
