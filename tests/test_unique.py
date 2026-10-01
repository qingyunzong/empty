import unittest

from secidx import Store, UniqueViolation, TxnNotActive
from reference import RefStore


def make_pair():
    real = Store()
    real.create_index("by_email", "email", unique=True)
    ref = RefStore()
    ref.create_index("by_email", "email", unique=True)
    return real, ref


def run_script(store, script):
    """Run a script of symbolic ops; return normalized observable results."""
    txns = {}
    out = []

    def txn_of(label):
        return txns[label]

    for step in script:
        op = step[0]
        try:
            if op == "begin":
                txns[step[1]] = store.begin()
                out.append(("begin",))
            elif op == "insert":
                store.insert(txn_of(step[1]), step[2], step[3])
                out.append(("ok",))
            elif op == "update":
                store.update(txn_of(step[1]), step[2], step[3])
                out.append(("ok",))
            elif op == "delete":
                store.delete(txn_of(step[1]), step[2])
                out.append(("ok",))
            elif op == "commit":
                store.commit(txn_of(step[1]))
                out.append(("ok",))
            elif op == "abort":
                store.abort(txn_of(step[1]))
                out.append(("ok",))
            elif op == "find":
                rows = store.find(None, "by_email", step[1])
                out.append(("rows", [(r["pk"], r["fields"]) for r in rows]))
        except Exception as exc:
            out.append(("err", getattr(exc, "code", type(exc).__name__)))
    return out, store


class UniqueViolationTest(unittest.TestCase):
    def test_same_txn_duplicate_key_fails_whole_txn(self):
        store, _ = make_pair()
        txn = store.begin()
        store.insert(txn, "u1", {"email": "a@x", "n": 1})
        with self.assertRaises(UniqueViolation) as ctx:
            store.insert(txn, "u2", {"email": "a@x", "n": 2})
        self.assertEqual(ctx.exception.code, "UNIQUE_VIOLATION")
        # whole transaction failed: no partial effects, txn is dead
        self.assertEqual(store.find(None, "by_email", "a@x"), [])
        self.assertEqual(store.rows, {})
        with self.assertRaises(TxnNotActive):
            store.commit(txn)

    def test_conflict_with_committed_row(self):
        store, _ = make_pair()
        t0 = store.begin()
        store.insert(t0, "u1", {"email": "a@x"})
        store.commit(t0)
        t1 = store.begin()
        store.insert(t1, "u9", {"email": "ok@x"})
        with self.assertRaises(UniqueViolation):
            store.insert(t1, "u2", {"email": "a@x"})
        # no partial effects from t1
        self.assertEqual(store.find(None, "by_email", "ok@x"), [])
        self.assertEqual(list(store.rows), ["u1"])

    def test_update_causing_conflict_fails_txn(self):
        store, _ = make_pair()
        t0 = store.begin()
        store.insert(t0, "u1", {"email": "a@x"})
        store.insert(t0, "u2", {"email": "b@x"})
        store.commit(t0)
        t1 = store.begin()
        with self.assertRaises(UniqueViolation):
            store.update(t1, "u2", {"email": "a@x"})
        self.assertEqual([r["pk"] for r in store.find(None, "by_email", "b@x")],
                         ["u2"])

    def test_interleaved_same_key_matches_serial_reference(self):
        # acceptance (a): two txns interleave inserts of the same unique
        # key; outcome must equal the serial reference (first committer
        # wins, the other fails with UNIQUE_VIOLATION, no partial effects).
        scenarios = {
            "a_commits_first": [
                ("begin", "A"), ("begin", "B"),
                ("insert", "A", "u1", {"email": "dup@x"}),
                ("insert", "B", "u2", {"email": "dup@x"}),
                ("commit", "A"),
                ("commit", "B"),
                ("find", "dup@x"),
            ],
            "b_commits_first": [
                ("begin", "A"), ("begin", "B"),
                ("insert", "A", "u1", {"email": "dup@x"}),
                ("insert", "B", "u2", {"email": "dup@x"}),
                ("commit", "B"),
                ("commit", "A"),
                ("find", "dup@x"),
            ],
            "loser_had_prior_writes": [
                ("begin", "A"), ("begin", "B"),
                ("insert", "B", "u0", {"email": "free@x"}),
                ("insert", "A", "u1", {"email": "dup@x"}),
                ("insert", "B", "u2", {"email": "dup@x"}),
                ("commit", "A"),
                ("commit", "B"),  # B fails entirely: u0 must not leak
                ("find", "dup@x"),
                ("find", "free@x"),
            ],
        }
        for name, script in scenarios.items():
            with self.subTest(scenario=name):
                real, ref = make_pair()
                real_out, real_store = run_script(real, script)
                ref_out, ref_store = run_script(ref, script)
                self.assertEqual(real_out, ref_out)
                self.assertEqual(real_store.rows, ref_store.rows)
                # sanity: exactly one committer won, loser fully rolled back
                self.assertEqual(len(real_store.rows), 1)

    def test_unique_index_creation_over_duplicates_fails(self):
        store = Store()
        t = store.begin()
        store.insert(t, "u1", {"email": "a@x"})
        store.insert(t, "u2", {"email": "a@x"})
        store.commit(t)
        with self.assertRaises(UniqueViolation):
            store.create_index("by_email", "email", unique=True)
        self.assertNotIn("by_email", store.indexes)


if __name__ == "__main__":
    unittest.main()
