# D1 migration for rr-durbar-api: change list (task 4.2 and the database side of 4.4)

Files only. Nothing here deploys anything. Apply them in your own session.

## Files and where they go (rr-durbar-api repo)
| File | Destination | Notes |
|---|---|---|
| `migrations/0001_schema.sql` | `migrations/0001_schema.sql` | 12 tables, indexes. No PRAGMAs. Money is integer paise. |
| `migrations/0002_guards.sql` | `migrations/0002_guards.sql` | State guard trigger, audit triggers, append-only triggers, `v_open_orders` view. Separate file so a trigger problem cannot block the tables. |
| `tools/rollback_dev_only.sql` | `tools/` (NOT in `migrations/`) | Drops everything. Dev or staging only. Keep it out of `migrations/` or a migration runner will apply it. |
| `tests/test_schema.py` | `tests/` | 22 checks on real SQLite (same engine as D1). Run: `python3 tests/test_schema.py` (pass the migrations folder as the first argument if the paths differ). Port to your vitest setup if you prefer; the cases are the spec. |

## What the schema enforces (so a bug in the API cannot break it)
- Money: integer paise, `total = subtotal + tax + charges`, no negatives. Pay at pickup capped at Rs 1000.00 inclusive (100000 paise); Rs 1000.01 is refused by the database too. **Raising the limit later needs a new migration.**
- A payu order is never in `CREATED`; a cod order is never in a payment state.
- Only legal state transitions (contract section 4). `CONFIRMED` is final. Every state change writes an `events` row (actor and note come from `orders.last_actor` and `orders.last_note`, set in the same UPDATE).
- Compare-and-set works: `UPDATE ... WHERE id=? AND state=?` changes 0 rows for the second writer (duplicate PayU callback or webhook).
- One SUCCESS payment per order; `txnid` unique. Rista push attempts unique per order. This order can be credited loyalty points only once (`UNIQUE(order_id, kind)`).
- OTP: attempt cap of 5 enforced by the table; tokens (`otp_nonces`) are claimed atomically; codes stored hashed only.
- `consents` and `events` are append-only (updates and deletes abort).

## Deviations from the contract v1 (update the contract text; see the patch below)
1. Idempotency lives in its own table `idempotency_keys` (key, request_hash, order_id, response_json), not a unique column on `orders`.
2. `orders.charges_paise` added (packaging or other Rista charges; confirm in task 4.5). Until confirmed keep it 0.
3. `orders.last_actor` and `last_note` added to feed the audit trigger.
4. Two states beyond the contract: `REFUNDED` (owner marks a refund done) and transitions `PAYMENT_FAILED -> REFUND_NEEDED` and `EXPIRED -> REFUND_NEEDED` (PayU reports money taken on a dead order).
5. New tables: `otp_challenges` (OTP attempt counting in D1, since KV is not atomic), `rate_events` (exact rate limits), `loyalty_events` (Reelo earn queue, earn-only v1).
6. Open-order cap uses `v_open_orders`: states CREATED, PAYMENT_PENDING, PAID, PUSH_FAILED, PUSHED_TO_RISTA, CONFIRMED with a pickup slot less than 2 hours old. **Definition needs owner or Rista confirmation.**

## Not done and why
- No seed data, no `wrangler.toml` change, no migration-apply commands (your call, local first).
- Reelo capture-bill and redeem/revert columns wait for Reelo's missing docs (earn-only `kind` for now).
- If D1 rejects the trigger statements in `0002`, send me the exact error text; the tables in `0001` are independent of it.
