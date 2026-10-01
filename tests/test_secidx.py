"""Core semantics tests for secidx, covering acceptance criteria a-e."""

import random
import unittest

from secidx import (
    Database,
    DuplicatePk,
    NoSuchTxn,
    NotFound,
    TxnConflict,
    UniqueViolation,
)
from secidx.core import pk_sort_key


def pks(rows):
    return [r["pk"] for r in rows]


class UniqueIndexTests(unittest.TestCase):
    def setUp(self):
        self.db = Database()
        self.db.create_index("email", unique=True)
        self.db.create_index("tag", unique=False)

    def test_interleaved_unique_insert_matches_serial_reference(self):
        """(a) Two txns race on the same unique key; the loser fails with
        UNIQUE_VIOLATION and the committed state equals the serial execution
        where the winner's transaction ran first."""
        db = self.db
        db.begin("t1")
        db.begin("t2")
        db.insert("t1", 1, {"email": "x@example.com", "tag": "a"})
        # t2 loses the race: immediate UNIQUE_VIOLATION, whole txn aborted.
        with self.assertRaises(UniqueViolation):
            db.insert("t2", 2, {"email": "x@example.com", "tag": "b"})
        with self.assertRaises(NoSuchTxn):
            db.commit("t2")
        db.commit("t1")

        # Serial reference: t1 then t2 -> t2's insert violates uniqueness.
        ref = Database()
        ref.create_index("email", unique=True)
        ref.create_index("tag", unique=False)
        ref.begin("r1")
        ref.insert("r1", 1, {"email": "x@example.com", "tag": "a"})
        ref.commit("r1")
        ref.begin("r2")
        with self.assertRaises(UniqueViolation):
            ref.insert("r2", 2, {"email": "x@example.com", "tag": "b"})

        db.begin("q")
        ref.begin("q")
        self.assertEqual(db.scan("q"), ref.scan("q"))
        self.assertEqual(pks(db.find("q", "email", "x@example.com")), [1])
        self.assertEqual(db.find("q", "email", "x@example.com"),
                         ref.find("q", "email", "x@example.com"))
        db.abort("q")

    def test_interleaved_unique_insert_reverse_order(self):
        """(a) Same race, other winner: state equals the other serial order."""
        db = self.db
        db.begin("t1")
        db.begin("t2")
        db.insert("t2", 2, {"email": "x@example.com"})
        with self.assertRaises(UniqueViolation):
            db.insert("t1", 1, {"email": "x@example.com"})
        db.commit("t2")
        db.begin("q")
        self.assertEqual(pks(db.find("q", "email", "x@example.com")), [2])
        self.assertEqual(pks(db.scan("q")), [2])

    def test_unique_violation_rolls_back_whole_transaction(self):
        """No partial effects: earlier writes of the failed txn vanish too."""
        db = self.db
        db.begin("t0")
        db.insert("t0", 1, {"email": "taken@example.com", "tag": "a"})
        db.commit("t0")

        db.begin("t1")
        db.insert("t1", 2, {"email": "fresh@example.com", "tag": "b"})
        db.insert("t1", 3, {"email": "other@example.com", "tag": "b"})
        with self.assertRaises(UniqueViolation):
            db.insert("t1", 4, {"email": "taken@example.com", "tag": "c"})
        with self.assertRaises(NoSuchTxn):
            db.commit("t1")

        db.begin("q")
        self.assertEqual(pks(db.scan("q")), [1])
        self.assertEqual(db.find("q", "email", "fresh@example.com"), [])
        self.assertEqual(db.find("q", "tag", "b"), [])

    def test_uncommitted_invisible_to_others_visible_to_self(self):
        """(3) Own uncommitted writes count for uniqueness and reads;
        other transactions must not see them."""
        db = self.db
        db.begin("t1")
        db.insert("t1", 1, {"email": "x@example.com", "tag": "a"})
        # own writes visible to self
        self.assertEqual(pks(db.find("t1", "email", "x@example.com")), [1])
        # ... and to own uniqueness checks
        with self.assertRaises(UniqueViolation):
            db.insert("t1", 2, {"email": "x@example.com"})
        # t1 aborted itself by the violation; restart it
        db.begin("t1")
        db.insert("t1", 1, {"email": "x@example.com", "tag": "a"})
        db.begin("t2")
        self.assertEqual(db.find("t2", "email", "x@example.com"), [])
        self.assertEqual(db.scan("t2"), [])
        db.commit("t1")
        self.assertEqual(pks(db.find("t2", "email", "x@example.com")), [1])
        db.abort("t2")

    def test_abort_removes_index_entries(self):
        """(b) After abort, the txn's index entries are completely gone."""
        db = self.db
        db.begin("t1")
        db.insert("t1", 1, {"email": "x@example.com", "tag": "a"})
        db.insert("t1", 2, {"email": "y@example.com", "tag": "a"})
        db.abort("t1")
        db.begin("q")
        self.assertEqual(db.find("q", "email", "x@example.com"), [])
        self.assertEqual(db.find("q", "email", "y@example.com"), [])
        self.assertEqual(db.find("q", "tag", "a"), [])
        self.assertEqual(db.scan("q"), [])
        # the unique key is free again
        db.begin("t2")
        db.insert("t2", 3, {"email": "x@example.com"})
        db.commit("t2")
        self.assertEqual(pks(db.find("q", "email", "x@example.com")), [3])

    def test_update_moves_index_entry(self):
        """(c) update = delete-old + insert-new for index entries."""
        db = self.db
        db.begin("t1")
        db.insert("t1", 1, {"email": "old@example.com", "tag": "a"})
        db.commit("t1")
        db.begin("t2")
        db.update("t2", 1, {"email": "new@example.com"})
        db.commit("t2")
        db.begin("q")
        self.assertEqual(db.find("q", "email", "old@example.com"), [])
        self.assertEqual(pks(db.find("q", "email", "new@example.com")), [1])
        # untouched field still indexed
        self.assertEqual(pks(db.find("q", "tag", "a")), [1])

    def test_update_unique_conflict_aborts_and_preserves_old_state(self):
        db = self.db
        db.begin("t1")
        db.insert("t1", 1, {"email": "a@example.com"})
        db.insert("t1", 2, {"email": "b@example.com"})
        db.commit("t1")
        db.begin("t2")
        with self.assertRaises(UniqueViolation):
            db.update("t2", 2, {"email": "a@example.com"})
        db.begin("q")
        self.assertEqual(pks(db.find("q", "email", "b@example.com")), [2])

    def test_delete_removes_index_entries(self):
        """(4) delete synchronously removes index entries."""
        db = self.db
        db.begin("t1")
        db.insert("t1", 1, {"email": "x@example.com", "tag": "a"})
        db.commit("t1")
        db.begin("t2")
        db.delete("t2", 1)
        # invisible to self already, before commit
        self.assertEqual(db.find("t2", "email", "x@example.com"), [])
        db.commit("t2")
        db.begin("q")
        self.assertEqual(db.find("q", "email", "x@example.com"), [])
        self.assertEqual(db.find("q", "tag", "a"), [])
        self.assertEqual(db.scan("q"), [])
        # unique key reusable after delete
        db.begin("t3")
        db.insert("t3", 9, {"email": "x@example.com"})
        db.commit("t3")
        self.assertEqual(pks(db.find("q", "email", "x@example.com")), [9])

    def test_empty_find_returns_empty_list(self):
        """(d) Empty results are [], not errors."""
        db = self.db
        db.begin("q")
        self.assertEqual(db.find("q", "email", "nobody@example.com"), [])
        self.assertEqual(db.find("q", "tag", "nothing"), [])
        self.assertEqual(db.find("q", "unindexed_field", 42), [])
        self.assertEqual(db.scan("q"), [])

    def test_non_unique_index_returns_all_matches(self):
        db = self.db
        db.begin("t1")
        for i in range(5):
            db.insert("t1", i, {"email": f"u{i}@example.com", "tag": "g"})
        db.commit("t1")
        db.begin("q")
        self.assertEqual(pks(db.find("q", "tag", "g")), [0, 1, 2, 3, 4])

    def test_duplicate_pk_and_not_found(self):
        db = self.db
        db.begin("t1")
        db.insert("t1", 1, {"email": "x@example.com"})
        with self.assertRaises(DuplicatePk):
            db.insert("t1", 1, {"email": "z@example.com"})
        with self.assertRaises(NotFound):
            db.delete("t1", 999)
        with self.assertRaises(NotFound):
            db.update("t1", 999, {"email": "z@example.com"})

    def test_row_level_write_conflict(self):
        db = self.db
        db.begin("t1")
        db.insert("t1", 1, {"email": "x@example.com"})
        db.commit("t1")
        db.begin("t2")
        db.begin("t3")
        db.update("t2", 1, {"tag": "t2"})
        with self.assertRaises(TxnConflict):
            db.update("t3", 1, {"tag": "t3"})
        db.commit("t2")
        db.begin("q")
        self.assertEqual(db.find("q", "tag", "t3"), [])
        self.assertEqual(pks(db.find("q", "tag", "t2")), [1])

    def test_create_unique_index_over_duplicates_fails(self):
        db = Database()
        db.begin("t1")
        db.insert("t1", 1, {"email": "dup@example.com"})
        db.insert("t1", 2, {"email": "dup@example.com"})
        db.commit("t1")
        with self.assertRaises(UniqueViolation):
            db.create_index("email", unique=True)
        # failed creation leaves no index behind
        db.begin("q")
        self.assertEqual(pks(db.find("q", "email", "dup@example.com")), [1, 2])


class ReferenceModel:
    """Brute-force serial reference: deep-copies state per transaction and
    answers every query by full scan.  Obviously correct, deliberately slow."""

    def __init__(self, unique_fields):
        self.rows = {}
        self.unique_fields = set(unique_fields)
        self.stage = None

    def begin(self):
        assert self.stage is None
        self.stage = {pk: dict(f) for pk, f in self.rows.items()}

    def commit(self):
        self.rows, self.stage = self.stage, None

    def abort(self):
        self.stage = None

    def _check_unique(self, pk, fields):
        for field in self.unique_fields:
            if field not in fields:
                continue
            for other_pk, other in self.stage.items():
                if other_pk != pk and other.get(field) == fields[field]:
                    raise UniqueViolation(f"ref: {field}={fields[field]!r}")

    def insert(self, pk, fields):
        if pk in self.stage:
            raise DuplicatePk(pk)
        self._check_unique(pk, fields)
        self.stage[pk] = dict(fields)

    def update(self, pk, fields):
        if pk not in self.stage:
            raise NotFound(pk)
        new = dict(self.stage[pk])
        new.update(fields)
        self._check_unique(pk, new)
        self.stage[pk] = new

    def delete(self, pk):
        if pk not in self.stage:
            raise NotFound(pk)
        del self.stage[pk]

    def find(self, field, value):
        src = self.stage if self.stage is not None else self.rows
        return [{"pk": pk, "fields": dict(f)}
                for pk, f in sorted(src.items(), key=lambda kv: pk_sort_key(kv[0]))
                if f.get(field) == value]

    def scan(self):
        src = self.stage if self.stage is not None else self.rows
        return [{"pk": pk, "fields": dict(f)}
                for pk, f in sorted(src.items(), key=lambda kv: pk_sort_key(kv[0]))]


class RandomizedComparisonTest(unittest.TestCase):
    """(e) Random workloads: secidx results must equal the brute-force
    reference model's results, query for query."""

    def run_workload(self, seed, steps):
        rng = random.Random(seed)
        db = Database()
        db.create_index("u", unique=True)
        db.create_index("n", unique=False)
        ref = ReferenceModel(unique_fields={"u"})

        db.begin("t")
        ref.begin()
        txn_open = True

        for step in range(steps):
            op = rng.choice(
                ["insert"] * 4 + ["update"] * 2 + ["delete"] * 2
                + ["find"] * 3 + ["scan"] + ["commit", "abort", "reopen"])
            pk = rng.randrange(12)
            u_val = rng.randrange(6)        # small domain -> collisions
            n_val = rng.choice(["red", "green", "blue"])
            fields = {"u": u_val, "n": n_val, "payload": rng.randrange(100)}

            if op in ("commit", "abort", "reopen"):
                if txn_open:
                    if op == "abort" or rng.random() < 0.5:
                        db.abort("t")
                        ref.abort()
                    else:
                        db.commit("t")
                        ref.commit()
                    txn_open = False
                if op == "reopen" or (op in ("commit", "abort") and rng.random() < 0.7):
                    db.begin("t")
                    ref.begin()
                    txn_open = True
                continue

            if not txn_open:
                db.begin("t")
                ref.begin()
                txn_open = True

            if op == "find":
                field = rng.choice(["u", "n", "missing_field"])
                value = rng.randrange(6) if field == "u" else (
                    rng.choice(["red", "green", "blue"]) if field == "n" else 1)
                got = db.find("t", field, value)
                want = ref.find(field, value)
                self.assertEqual(got, want,
                                 f"seed={seed} step={step} find {field}={value}")
            elif op == "scan":
                self.assertEqual(db.scan("t"), ref.scan(),
                                 f"seed={seed} step={step} scan")
            else:
                got_err = want_err = None
                try:
                    if op == "delete":
                        db.delete("t", pk)
                    else:
                        getattr(db, op)("t", pk, fields)
                except (UniqueViolation, DuplicatePk, NotFound) as exc:
                    got_err = type(exc)
                try:
                    if op == "delete":
                        ref.delete(pk)
                    else:
                        getattr(ref, op)(pk, fields)
                except (UniqueViolation, DuplicatePk, NotFound) as exc:
                    want_err = type(exc)
                self.assertEqual(got_err, want_err,
                                 f"seed={seed} step={step} {op} pk={pk}")
                if got_err is UniqueViolation:
                    # secidx aborted the whole txn; mirror that on the
                    # reference side and reopen both.
                    db.begin("t")
                    ref.abort()
                    ref.begin()

        if txn_open:
            db.commit("t")
            ref.commit()
        db.begin("final")
        self.assertEqual(db.scan("final"), ref.scan())

    def test_random_workloads_match_reference(self):
        for seed in range(30):
            with self.subTest(seed=seed):
                self.run_workload(seed, steps=300)


if __name__ == "__main__":
    unittest.main()
