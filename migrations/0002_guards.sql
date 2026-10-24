-- RR Durbar ordering API: D1 schema, part 2 of 2 (state machine guard, audit trigger, open-orders view). Tasks 4.2 and 4.4.
-- Kept separate from 0001 so a problem with triggers cannot block the tables. Apply 0001 first.

-- Legal transitions (contract section 4). Anything else aborts the UPDATE.
-- Two additions to the contract, flagged: REFUND_NEEDED -> REFUNDED (owner marks a refund done), and
-- PAYMENT_FAILED / EXPIRED -> REFUND_NEEDED (PayU later reports money captured on a dead order).
CREATE TRIGGER trg_orders_state_guard
BEFORE UPDATE OF state ON orders
WHEN NEW.state <> OLD.state AND NOT (
     (OLD.state = 'CREATED'         AND NEW.state IN ('PUSHED_TO_RISTA','PUSH_FAILED'))
  OR (OLD.state = 'PAYMENT_PENDING' AND NEW.state IN ('PAID','PAYMENT_FAILED','EXPIRED'))
  OR (OLD.state = 'PAID'            AND NEW.state IN ('PUSHED_TO_RISTA','PUSH_FAILED'))
  OR (OLD.state = 'PUSH_FAILED'     AND NEW.state IN ('PUSHED_TO_RISTA','REFUND_NEEDED','CANCELLED'))
  OR (OLD.state = 'PUSHED_TO_RISTA' AND NEW.state = 'CONFIRMED')
  OR (OLD.state IN ('PAYMENT_FAILED','EXPIRED') AND NEW.state = 'REFUND_NEEDED')
  OR (OLD.state = 'REFUND_NEEDED'   AND NEW.state = 'REFUNDED')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal order state transition');
END;

-- Every state change writes an events row. The app sets last_actor and last_note in the same UPDATE.
CREATE TRIGGER trg_orders_state_event
AFTER UPDATE OF state ON orders
WHEN NEW.state <> OLD.state
BEGIN
  INSERT INTO events (order_id, from_state, to_state, actor, note)
  VALUES (NEW.id, OLD.state, NEW.state, COALESCE(NEW.last_actor, 'unknown'), NEW.last_note);
END;

-- New orders also get an events row (first state).
CREATE TRIGGER trg_orders_created_event
AFTER INSERT ON orders
BEGIN
  INSERT INTO events (order_id, from_state, to_state, actor, note)
  VALUES (NEW.id, NULL, NEW.state, COALESCE(NEW.last_actor, 'api'), NEW.last_note);
END;

-- Consent rows and events are history: no edits, no deletes.
CREATE TRIGGER trg_consents_no_update BEFORE UPDATE ON consents BEGIN SELECT RAISE(ABORT, 'consents are append-only'); END;
CREATE TRIGGER trg_consents_no_delete BEFORE DELETE ON consents BEGIN SELECT RAISE(ABORT, 'consents are append-only'); END;
CREATE TRIGGER trg_events_no_update   BEFORE UPDATE ON events   BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER trg_events_no_delete   BEFORE DELETE ON events   BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- Open orders per customer for the "max 2 open orders" rule. Definition [TBC with owner]: not failed/expired/cancelled/refunded,
-- and the pickup slot is less than 2 hours old. Query: SELECT open_count FROM v_open_orders WHERE customer_id = ?
CREATE VIEW v_open_orders AS
SELECT customer_id, COUNT(*) AS open_count
FROM orders
WHERE state IN ('CREATED','PAYMENT_PENDING','PAID','PUSH_FAILED','PUSHED_TO_RISTA','CONFIRMED')
  AND slot_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours')
GROUP BY customer_id;
