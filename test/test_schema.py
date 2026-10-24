# Runs the migrations against real SQLite (same engine as D1). Usage: python3 test_schema.py [path/to/migrations]
import sqlite3, sys, os, unittest, hashlib
MIG = sys.argv.pop(1) if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]) else os.path.join(os.path.dirname(__file__), '..', 'migrations')

def fresh():
    c = sqlite3.connect(':memory:'); c.execute('PRAGMA foreign_keys=ON')
    for f in ('0001_schema.sql', '0002_guards.sql'): c.executescript(open(os.path.join(MIG, f)).read())
    return c
def cust(c, phone='9876543210'):
    c.execute('INSERT OR IGNORE INTO customers(phone,name) VALUES(?,?)', (phone, 'Asha')); return c.execute('SELECT id FROM customers WHERE phone=?', (phone,)).fetchone()[0]
def order(c, oid='RR-100001', method='payu', state=None, total=68040, sub=64800, tax=3240, charges=0, slot='2099-01-01T00:00:00.000Z', cid=None):
    state = state or ('PAYMENT_PENDING' if method == 'payu' else 'CREATED')
    c.execute('INSERT INTO orders(id,branch,slot_at,method,state,subtotal_paise,tax_paise,charges_paise,total_paise,customer_id,status_token_hash,last_actor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
              (oid, 'poranki', slot, method, state, sub, tax, charges, total, cid or cust(c), 'h', 'api'))
def move(c, oid, frm, to, actor='test'):
    return c.execute('UPDATE orders SET state=?, version=version+1, last_actor=?, updated_at=? WHERE id=? AND state=?', (to, actor, '2026-10-24T00:00:00Z', oid, frm)).rowcount

class T(unittest.TestCase):
    def setUp(self): self.c = fresh()
    def bad(self, sql, args=()):
        with self.assertRaises(sqlite3.Error): self.c.execute(sql, args)

    def test_phone_rules(self):
        for p in ('12345', '5876543210', '98765x3210', '09876543210', ''): self.bad('INSERT INTO customers(phone) VALUES(?)', (p,))
        cust(self.c)                                      # valid
        self.bad('INSERT INTO customers(phone) VALUES(?)', ('9876543210',))   # duplicate
    def test_money_must_add_up(self):
        order(self.c)                                     # 64800 + 3240 = 68040
        self.bad("INSERT INTO orders(id,branch,slot_at,method,state,subtotal_paise,tax_paise,total_paise,customer_id,status_token_hash) VALUES('RR-100002','poranki','x','payu','PAYMENT_PENDING',100,5,999,1,'h')")
        self.bad("INSERT INTO orders(id,branch,slot_at,method,state,subtotal_paise,tax_paise,total_paise,customer_id,status_token_hash) VALUES('RR-100003','poranki','x','payu','PAYMENT_PENDING',-100,105,5,1,'h')")
    def test_cod_limit_is_inclusive(self):
        order(self.c, 'RR-100010', 'cod', total=100000, sub=95238, tax=4762)                # exactly Rs 1000.00: allowed
        with self.assertRaises(sqlite3.Error): order(self.c, 'RR-100011', 'cod', total=100001, sub=95239, tax=4762)   # Rs 1000.01: refused
        order(self.c, 'RR-100012', 'payu', total=100001, sub=95239, tax=4762)               # online has no cap
    def test_state_must_fit_method(self):
        with self.assertRaises(sqlite3.Error): order(self.c, 'RR-100020', 'payu', state='CREATED')
        with self.assertRaises(sqlite3.Error): order(self.c, 'RR-100021', 'cod', state='PAID')
        with self.assertRaises(sqlite3.Error): order(self.c, 'RR-100022', 'cod', state='PAYMENT_PENDING')
    def test_order_id_format(self):
        with self.assertRaises(sqlite3.Error): order(self.c, 'ABC-1')
    def test_legal_payu_path_logs_every_step(self):
        order(self.c)
        for frm, to in (('PAYMENT_PENDING', 'PAID'), ('PAID', 'PUSHED_TO_RISTA'), ('PUSHED_TO_RISTA', 'CONFIRMED')): self.assertEqual(move(self.c, 'RR-100001', frm, to, 'payu_callback'), 1)
        ev = self.c.execute('SELECT from_state,to_state,actor FROM events WHERE order_id=? ORDER BY id', ('RR-100001',)).fetchall()
        self.assertEqual(ev, [(None, 'PAYMENT_PENDING', 'api'), ('PAYMENT_PENDING', 'PAID', 'payu_callback'), ('PAID', 'PUSHED_TO_RISTA', 'payu_callback'), ('PUSHED_TO_RISTA', 'CONFIRMED', 'payu_callback')])
    def test_legal_cod_paths(self):
        order(self.c, 'RR-100030', 'cod', total=50000, sub=47619, tax=2381)
        self.assertEqual(move(self.c, 'RR-100030', 'CREATED', 'PUSH_FAILED'), 1); self.assertEqual(move(self.c, 'RR-100030', 'PUSH_FAILED', 'PUSHED_TO_RISTA'), 1); self.assertEqual(move(self.c, 'RR-100030', 'PUSHED_TO_RISTA', 'CONFIRMED'), 1)
        order(self.c, 'RR-100031', 'cod', total=50000, sub=47619, tax=2381); move(self.c, 'RR-100031', 'CREATED', 'PUSH_FAILED'); self.assertEqual(move(self.c, 'RR-100031', 'PUSH_FAILED', 'CANCELLED'), 1)
    def test_money_taken_on_dead_order_goes_to_refund(self):
        order(self.c); move(self.c, 'RR-100001', 'PAYMENT_PENDING', 'EXPIRED', 'cron'); self.assertEqual(move(self.c, 'RR-100001', 'EXPIRED', 'REFUND_NEEDED', 'payu_webhook'), 1); self.assertEqual(move(self.c, 'RR-100001', 'REFUND_NEEDED', 'REFUNDED', 'owner'), 1)
    def test_illegal_jumps_are_blocked(self):
        order(self.c)
        for to in ('CONFIRMED', 'PUSHED_TO_RISTA', 'CREATED', 'REFUNDED', 'CANCELLED'):
            with self.assertRaises(sqlite3.Error): move(self.c, 'RR-100001', 'PAYMENT_PENDING', to)
        move(self.c, 'RR-100001', 'PAYMENT_PENDING', 'PAYMENT_FAILED')
        with self.assertRaises(sqlite3.Error): move(self.c, 'RR-100001', 'PAYMENT_FAILED', 'PAID')      # a failed order cannot quietly become paid
        order(self.c, 'RR-100002'); [move(self.c, 'RR-100002', a, b) for a, b in (('PAYMENT_PENDING','PAID'),('PAID','PUSHED_TO_RISTA'),('PUSHED_TO_RISTA','CONFIRMED'))]
        with self.assertRaises(sqlite3.Error): move(self.c, 'RR-100002', 'CONFIRMED', 'CANCELLED')       # CONFIRMED is final
    def test_compare_and_set_second_writer_loses(self):
        order(self.c)
        self.assertEqual(move(self.c, 'RR-100001', 'PAYMENT_PENDING', 'PAID', 'payu_callback'), 1)
        self.assertEqual(move(self.c, 'RR-100001', 'PAYMENT_PENDING', 'PAID', 'payu_webhook'), 0)       # duplicate callback: no change, no error
        self.assertEqual(self.c.execute("SELECT count(*) FROM events WHERE order_id='RR-100001' AND to_state='PAID'").fetchone()[0], 1)
    def test_event_log_and_consents_are_append_only(self):
        order(self.c); cid = cust(self.c)
        self.c.execute("INSERT INTO consents(customer_id,kind,granted,wording_version) VALUES(?,?,?,?)", (cid, 'terms', 1, 'v1'))
        self.bad("UPDATE consents SET granted=0"); self.bad("DELETE FROM consents"); self.bad("UPDATE events SET note='x'"); self.bad("DELETE FROM events")
        self.bad("INSERT INTO consents(customer_id,kind,granted,wording_version) VALUES(?,?,?,?)", (cid, 'other', 1, 'v1'))
        self.bad("INSERT INTO consents(customer_id,kind,granted,wording_version) VALUES(?,?,?,?)", (cid, 'terms', 1, ''))
    def test_foreign_keys_enforced(self):
        self.bad("INSERT INTO order_items(order_id,rista_item_id,name,qty,unit_paise,line_paise) VALUES('RR-999999','r1','x',1,100,100)")
    def test_line_items(self):
        order(self.c); ins = "INSERT INTO order_items(order_id,rista_item_id,name,qty,unit_paise,line_paise) VALUES('RR-100001','r1','Biryani',?,?,?)"
        self.c.execute(ins, (2, 34900, 69800))
        self.bad(ins, (2, 34900, 34900)); self.bad(ins, (0, 100, 0)); self.bad(ins, (21, 100, 2100))
    def test_one_payment_success_per_order_and_unique_txnid(self):
        order(self.c); ins = "INSERT INTO payments(order_id,txnid,status,amount_paise) VALUES('RR-100001',?,?,68040)"
        self.c.execute(ins, ('RR-100001', 'INITIATED')); self.bad(ins, ('RR-100001', 'FAILURE'))       # txnid unique
        self.c.execute("INSERT INTO payments(order_id,txnid,status,amount_paise) VALUES('RR-100001','RR-100001-b','SUCCESS',68040)")
        self.bad("INSERT INTO payments(order_id,txnid,status,amount_paise) VALUES('RR-100001','RR-100001-c','SUCCESS',68040)")   # second SUCCESS refused
        self.c.execute("INSERT INTO payments(order_id,txnid,status,amount_paise) VALUES('RR-100001','RR-100001-d','FAILURE',68040)")  # failures can repeat
    def test_rista_push_attempts_are_unique(self):
        order(self.c); ins = "INSERT INTO rista_pushes(order_id,attempt,status) VALUES('RR-100001',?,'FAILED')"
        self.c.execute(ins, (1,)); self.c.execute(ins, (2,)); self.bad(ins, (2,)); self.bad(ins, (0,))
    def test_idempotency_key(self):
        ins = "INSERT INTO idempotency_keys(key,phone,request_hash,expires_at) VALUES(?,?,?,?)"; k = '11111111-2222-4333-8444-555555555555'
        self.c.execute(ins, (k, '9876543210', 'h1', '2099')); self.bad(ins, (k, '9876543210', 'h2', '2099')); self.bad(ins, ('short', '9876543210', 'h', '2099'))
    def test_otp_attempt_cap_is_atomic_in_the_database(self):
        self.c.execute("INSERT INTO otp_challenges(phone,code_hash,expires_at) VALUES('9876543210','h','2099')")
        up = "UPDATE otp_challenges SET attempts=attempts+1 WHERE id=1 AND attempts<5 AND consumed_at IS NULL AND expires_at>'2026'"
        n = [self.c.execute(up).rowcount for _ in range(7)]; self.assertEqual(n, [1, 1, 1, 1, 1, 0, 0])   # sixth and seventh try are refused
        self.bad("UPDATE otp_challenges SET attempts=6 WHERE id=1")                                         # and the table itself refuses more than 5
    def test_token_is_used_once(self):
        self.c.execute("INSERT INTO otp_nonces(nonce,phone,expires_at) VALUES('n1','9876543210','2099')")
        claim = "UPDATE otp_nonces SET uses=uses+1 WHERE nonce='n1' AND uses<max_uses AND expires_at>'2026'"
        self.assertEqual(self.c.execute(claim).rowcount, 1); self.assertEqual(self.c.execute(claim).rowcount, 0)
        self.bad("UPDATE otp_nonces SET uses=2 WHERE nonce='n1'")
    def test_loyalty_cannot_be_credited_twice_for_one_order(self):
        order(self.c); cid = cust(self.c); ins = "INSERT INTO loyalty_events(order_id,customer_id,kind,points) VALUES('RR-100001',?,'earn',648)"
        self.c.execute(ins, (cid,)); self.bad(ins, (cid,)); self.bad("INSERT INTO loyalty_events(order_id,customer_id,kind,points) VALUES('RR-100001',?,'redeem',5)", (cid,))
        self.assertEqual(self.c.execute("SELECT status FROM loyalty_events").fetchone()[0], 'PENDING')
    def test_open_order_view(self):
        cid = cust(self.c)
        order(self.c, 'RR-100040', cid=cid); order(self.c, 'RR-100041', cid=cid)                           # two open (future slot)
        order(self.c, 'RR-100042', cid=cid); move(self.c, 'RR-100042', 'PAYMENT_PENDING', 'PAYMENT_FAILED')   # failed: not open
        order(self.c, 'RR-100043', cid=cid, slot='2000-01-01T00:00:00.000Z')                               # old slot: not open
        self.assertEqual(self.c.execute("SELECT open_count FROM v_open_orders WHERE customer_id=?", (cid,)).fetchone()[0], 2)
    def test_indexes_are_used(self):
        for q, idx in (("SELECT * FROM rate_events WHERE bucket='otp_phone' AND key='9876543210' AND at>'2026'", 'idx_rate_lookup'),
                       ("SELECT * FROM orders WHERE customer_id=1 AND state='CREATED'", 'idx_orders_customer_state'),
                       ("SELECT * FROM orders WHERE state='PAYMENT_PENDING' AND updated_at<'2026'", 'idx_orders_state_updated'),
                       ("SELECT * FROM loyalty_events WHERE status='PENDING' AND next_attempt_at<'2026'", 'idx_loyalty_pending')):
            plan = ' '.join(r[3] for r in self.c.execute('EXPLAIN QUERY PLAN ' + q)); self.assertIn(idx, plan, q)
    def test_rollback_script_leaves_nothing(self):
        self.c.executescript(open(os.path.join(MIG, '..', 'tools', 'rollback_dev_only.sql')).read())
        self.assertEqual(self.c.execute("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchone()[0], 0)

if __name__ == '__main__': unittest.main(verbosity=1)
