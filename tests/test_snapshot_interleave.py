"""Acceptance (a): two interleaved snapshot transactions.

Builds a visibility matrix (reader txn x key) and compares it key-by-key
against the pure-Python reference model.
"""

import unittest

from mvcc import READ_COMMITTED, SNAPSHOT, Store

from reference import RefModel

KEYS = ["a", "b", "c"]


def run_script(store, model):
    """A fixed interleaving of two snapshot txns plus a writer txn."""
    # Seed committed data before the snapshots begin.
    t0 = store.begin(READ_COMMITTED)
    m0 = model.begin(READ_COMMITTED)
    for k in KEYS:
        store.put(t0, k, f"{k}0")
        model.put(m0, k, f"{k}0")
    store.commit(t0)
    model.commit(m0)

    s1 = store.begin(SNAPSHOT)
    m1 = model.begin(SNAPSHOT)

    # Writer commits new values and a delete after s1's snapshot is taken.
    w = store.begin(READ_COMMITTED)
    mw = model.begin(READ_COMMITTED)
    store.put(w, "a", "a1")
    model.put(mw, "a", "a1")
    store.delete(w, "b")
    model.delete(mw, "b")
    store.commit(w)
    model.commit(mw)

    s2 = store.begin(SNAPSHOT)  # snapshot taken after w commits
    m2 = model.begin(SNAPSHOT)

    # s1 writes its own values (read-your-own-writes) but does not commit yet.
    store.put(s1, "c", "c1")
    model.put(m1, "c", "c1")

    matrix = {}
    for store_txn, model_txn, name in [(s1, m1, "s1"), (s2, m2, "s2")]:
        for k in KEYS:
            got = store.get(store_txn, k)
            want = model.get(model_txn, k)
            matrix[(name, k)] = got
            yield (name, k, got, want)

    # Commit s1, then check s2's snapshot is still fixed.
    store.commit(s1)
    model.commit(m1)
    for k in KEYS:
        got = store.get(s2, k)
        want = model.get(m2, k)
        matrix[("s2-post", k)] = got
        yield ("s2-post", k, got, want)


class TestSnapshotInterleave(unittest.TestCase):
    def test_visibility_matrix_matches_reference(self):
        store = Store()
        model = RefModel()
        mismatches = []
        for name, key, got, want in run_script(store, model):
            if got != want:
                mismatches.append((name, key, got, want))
        self.assertEqual(mismatches, [])

    def test_snapshot_is_fixed(self):
        store = Store()
        t0 = store.begin(READ_COMMITTED)
        store.put(t0, "x", "old")
        store.commit(t0)

        s = store.begin(SNAPSHOT)
        t1 = store.begin(READ_COMMITTED)
        store.put(t1, "x", "new")
        store.commit(t1)

        self.assertEqual(store.get(s, "x"), "old")
        rc = store.begin(READ_COMMITTED)
        self.assertEqual(store.get(rc, "x"), "new")

    def test_version_timestamps(self):
        store = Store()
        t1 = store.begin(READ_COMMITTED)
        store.put(t1, "k", "v1")
        c1 = store.commit(t1)
        t2 = store.begin(READ_COMMITTED)
        store.put(t2, "k", "v2")
        c2 = store.commit(t2)

        v1, v2 = store.versions("k")
        self.assertEqual((v1.begin_ts, v1.end_ts), (c1, c2))
        self.assertEqual((v2.begin_ts, v2.end_ts), (c2, None))
        self.assertLess(c1, c2)


if __name__ == "__main__":
    unittest.main()
