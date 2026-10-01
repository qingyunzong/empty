import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import lww
from lww import LWWError, Store

CLI = [sys.executable, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "lww.py")]


def run_cli(node, commands, env_extra=None):
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        CLI + [node], input="\n".join(json.dumps(c) for c in commands),
        capture_output=True, text=True, env=env, timeout=30)
    lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    return proc.returncode, lines


def model_entries(events):
    """Reference set model: per-key winner over all put/del events."""
    best = {}
    for ev in events:
        key = ev["key"]
        order = (ev["ts"], ev["node"])
        payload = (ev["tombstone"], "" if ev["value"] is None else ev["value"])
        cur = best.get(key)
        if cur is None or (order, payload) > cur[0]:
            best[key] = ((order, payload), ev)
    return {k: ev for k, (_, ev) in best.items()}


def visible_entries(store):
    return {k: e for k, e in store.entries.items()}


class TestAEnumerationVsModel(unittest.TestCase):
    """A: <=5 keys, <=20 ops, enumerate merge orders, match reference model."""

    def run_scenario(self, seed):
        rng = random.Random(seed)
        nodes = ["A", "B", "C"][: rng.randint(2, 3)]
        keys = ["k%d" % i for i in range(rng.randint(1, 5))]
        stores = {n: Store(n) for n in nodes}
        counters = {n: 0 for n in nodes}
        events = []

        n_ops = rng.randint(1, 20)
        for _ in range(n_ops):
            node = rng.choice(nodes)
            counters[node] += 1
            ts = counters[node]
            key = rng.choice(keys)
            if rng.random() < 0.3:
                stores[node].delete(key, ts)
                events.append({"key": key, "value": None, "ts": ts,
                               "node": node, "tombstone": True})
            else:
                value = "v%d" % rng.randint(0, 999)
                stores[node].put(key, value, ts)
                events.append({"key": key, "value": value, "ts": ts,
                               "node": node, "tombstone": False})
            # Random partial gossip between ops.
            if rng.random() < 0.4:
                src, dst = rng.sample(nodes, 2)
                stores[dst].merge(stores[src])

        expected = model_entries(events)

        # Enumerate every fold order of the replica states.
        for perm in itertools.permutations(nodes):
            merged = Store("M")
            for n in perm:
                merged.merge(stores[n])
            got = visible_entries(merged)
            self.assertEqual(set(got), set(expected))
            for key, exp in expected.items():
                ent = got[key]
                self.assertEqual(
                    (ent["value"], ent["ts"], ent["node"], ent["tombstone"]),
                    (exp["value"], exp["ts"], exp["node"], exp["tombstone"]),
                    "seed=%d key=%s perm=%s" % (seed, key, perm))
                if exp["tombstone"]:
                    self.assertIsNone(merged.get(key))
                else:
                    self.assertEqual(merged.get(key), exp["value"])

        # Full gossip among the live replicas converges to the model too.
        for _ in range(2):
            for src, dst in itertools.permutations(nodes, 2):
                stores[dst].merge(stores[src])
        for n in nodes:
            got = visible_entries(stores[n])
            self.assertEqual(set(got), set(expected))
            for key, exp in expected.items():
                ent = got[key]
                self.assertEqual(
                    (ent["value"], ent["ts"], ent["node"], ent["tombstone"]),
                    (exp["value"], exp["ts"], exp["node"], exp["tombstone"]))

    def test_enumeration(self):
        for seed in range(60):
            with self.subTest(seed=seed):
                self.run_scenario(seed)

    def test_merge_algebra(self):
        # Commutativity, associativity, idempotency on serialized state.
        for seed in range(30):
            rng = random.Random(1000 + seed)
            stores = []
            for n in ("A", "B", "C"):
                s = Store(n)
                for i in range(rng.randint(1, 6)):
                    key = "k%d" % rng.randint(0, 4)
                    if rng.random() < 0.4:
                        s.delete(key, i + 1)
                    else:
                        s.put(key, "v%d" % rng.randint(0, 99), i + 1)
                stores.append(s)
            a, b, c = stores

            def m(*xs):
                r = Store("M")
                for x in xs:
                    r.merge(x)
                return r.to_dict()

            self.assertEqual(m(a, b), m(b, a))          # commutative
            self.assertEqual(m(m_store(a, b), c), m(a, m_store(b, c)))  # assoc
            self.assertEqual(m(a, a), m(a))             # idempotent
            self.assertEqual(m(a, b, a, c, b), m(a, b, c))


def m_store(x, y):
    r = Store("M")
    r.merge(x)
    r.merge(y)
    return r


class TestBTombstoneVsConcurrentWrites(unittest.TestCase):
    """B: tombstone vs concurrent put resolved by the (ts, node) rule."""

    def test_tombstone_beats_older_put(self):
        a, b = Store("A"), Store("B")
        a.put("k", "old", 4)
        b.delete("k", 5)
        a.merge(b)
        b.merge(a)
        for s in (a, b):
            self.assertIsNone(s.get("k"))
            self.assertTrue(s.entries["k"]["tombstone"])

    def test_newer_put_beats_tombstone(self):
        a, b = Store("A"), Store("B")
        b.delete("k", 5)
        a.put("k", "new", 6)
        a.merge(b)
        b.merge(a)
        for s in (a, b):
            self.assertEqual(s.get("k"), "new")
            self.assertFalse(s.entries["k"]["tombstone"])

    def test_equal_ts_node_tiebreak(self):
        # Same ts: node id decides, deterministically in both merge orders.
        a, b = Store("A"), Store("B")
        a.put("k", "v", 5)
        b.delete("k", 5)
        ab, ba = Store("M"), Store("M")
        ab.merge(a); ab.merge(b)
        ba.merge(b); ba.merge(a)
        self.assertTrue(ab.entries["k"]["tombstone"])  # ("B" > "A")
        self.assertEqual(ab.to_dict()["entries"], ba.to_dict()["entries"])

        c, d = Store("C"), Store("D")
        c.put("k", "v", 5)
        d.delete("k", 4)
        cd = Store("M"); cd.merge(c); cd.merge(d)
        self.assertEqual(cd.get("k"), "v")

    def test_full_tie_is_same_write(self):
        # Identical (ts, node): same write; result deterministic either way.
        s1, s2 = Store("X"), Store("X")
        s1.put("k", "v1", 5, node="N")
        s2.delete("k", 5, node="N")
        f1 = Store("M"); f1.merge(s1); f1.merge(s2)
        f2 = Store("M"); f2.merge(s2); f2.merge(s1)
        self.assertEqual(f1.to_dict()["entries"], f2.to_dict()["entries"])
        # Idempotent: merging the same write twice changes nothing.
        s3 = Store("Y")
        s3.put("k", "v1", 5, node="N")
        snap = s3.to_dict()
        s3.put("k", "v1", 5, node="N")
        self.assertEqual(s3.to_dict(), snap)


class TestCPersistenceCrash(unittest.TestCase):
    """C: crash after tmp write, before rename; load recovers intact file."""

    def test_roundtrip_and_checksum(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "state.json")
            s = Store("A")
            s.put("k1", "v1", 1)
            s.put("k2", "v2", 2)
            s.delete("k1", 3)
            s.save(path)
            back = Store.load(path)
            self.assertEqual(back.to_dict(), s.to_dict())
            self.assertIsNone(back.get("k1"))
            self.assertEqual(back.get("k2"), "v2")

    def test_crash_before_rename_keeps_old_file(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "state.json")
            rc, out = run_cli("A", [
                {"op": "put", "key": "k1", "value": "old", "ts": 1},
                {"op": "save", "path": path},
            ])
            self.assertEqual(rc, 0, out)

            # Crash injected after tmp write, before rename.
            proc = subprocess.run(
                CLI + ["A"],
                input=json.dumps({"op": "load", "path": path}) + "\n"
                      + json.dumps({"op": "put", "key": "k2",
                                    "value": "new", "ts": 2}) + "\n"
                      + json.dumps({"op": "save", "path": path}) + "\n",
                capture_output=True, text=True,
                env=dict(os.environ, LWW_CRASH_BEFORE_RENAME="1"),
                timeout=30)
            self.assertEqual(proc.returncode, 2)  # simulated crash (os._exit)

            # The committed file is still the old, checksum-valid state.
            rc, out = run_cli("A", [
                {"op": "load", "path": path},
                {"op": "get", "key": "k1"},
                {"op": "get", "key": "k2"},
            ])
            self.assertEqual(rc, 0, out)
            self.assertTrue(out[0]["ok"])
            self.assertEqual(out[1]["value"], "old")
            self.assertFalse(out[2]["found"])

            # A clean save afterwards yields the new, checksum-valid state.
            rc, out = run_cli("A", [
                {"op": "load", "path": path},
                {"op": "put", "key": "k2", "value": "new", "ts": 2},
                {"op": "save", "path": path},
            ])
            self.assertEqual(rc, 0, out)
            rc, out = run_cli("A", [
                {"op": "load", "path": path},
                {"op": "get", "key": "k2"},
            ])
            self.assertEqual(rc, 0, out)
            self.assertEqual(out[1]["value"], "new")

    def test_corrupt_file_fails_checksum(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "state.json")
            Store("A").save(path)
            with open(path, "r+", encoding="utf-8") as fh:
                blob = json.load(fh)
                blob["payload"]["entries"].append(
                    {"key": "evil", "value": "x", "ts": 9, "node": "E",
                     "tombstone": False, "seen_by": []})
                fh.seek(0)
                fh.truncate()
                json.dump(blob, fh)
            with self.assertRaises(LWWError) as ctx:
                Store.load(path)
            self.assertEqual(ctx.exception.code, "CHECKSUM_MISMATCH")
            rc, out = run_cli("A", [{"op": "load", "path": path}])
            self.assertEqual(rc, 3)
            self.assertEqual(out[0]["error"], "CHECKSUM_MISMATCH")


class TestDGarbageCollection(unittest.TestCase):
    """D: unsafe gc returns GC_UNSAFE and leaves state unchanged."""

    def test_unsafe_gc_then_safe_gc(self):
        a, b = Store("A"), Store("B")
        a.put("k1", "v", 1)
        b.merge(a)                      # B now knows replica A exists
        b.delete("k1", 5)               # tombstone seen only by B
        before = b.to_dict()
        with self.assertRaises(LWWError) as ctx:
            b.gc(10)
        self.assertEqual(ctx.exception.code, "GC_UNSAFE")
        self.assertEqual(b.to_dict(), before)   # state unchanged
        self.assertIn("k1", b.entries)

        # A sees the tombstone, B learns that A saw it -> gc becomes safe.
        a.merge(b)
        b.merge(a)
        self.assertEqual(b.gc(10), 1)
        self.assertNotIn("k1", b.entries)

    def test_gc_keeps_younger_tombstones(self):
        s = Store("A")
        s.put("k", "v", 1)
        s.delete("k", 5)
        self.assertEqual(s.gc(5), 0)    # ts < before required
        self.assertIn("k", s.entries)
        self.assertEqual(s.gc(6), 1)
        self.assertNotIn("k", s.entries)

    def test_unsafe_gc_via_cli_exit_3(self):
        with tempfile.TemporaryDirectory() as td:
            path_b = os.path.join(td, "b.json")
            rc, out = run_cli("A", [
                {"op": "put", "key": "k1", "value": "v", "ts": 1},
                {"op": "dump"},
            ])
            self.assertEqual(rc, 0, out)
            state_a = out[1]["state"]
            rc, out = run_cli("B", [
                {"op": "merge", "state": state_a},
                {"op": "del", "key": "k1", "ts": 5},
                {"op": "gc", "before": 10},
                {"op": "get", "key": "k1"},
                {"op": "dump"},
                {"op": "save", "path": path_b},
            ])
            self.assertEqual(rc, 3)
            self.assertEqual(out[2]["error"], "GC_UNSAFE")
            self.assertFalse(out[3]["found"])       # tombstone hides value
            entries = out[4]["state"]["entries"]
            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0]["tombstone"])  # state unchanged
            self.assertTrue(out[5]["ok"])


class TestValidation(unittest.TestCase):
    def test_value_size_limit(self):
        s = Store("A")
        s.put("k", "x" * 64, 1)
        with self.assertRaises(LWWError) as ctx:
            s.put("k", "x" * 65, 2)
        self.assertEqual(ctx.exception.code, "VALUE_TOO_LARGE")
        with self.assertRaises(LWWError):
            s.put("k", "é" * 33, 2)  # 66 bytes utf-8

    def test_keyspace_limit(self):
        s = Store("A")
        for i in range(lww.MAX_KEYS):
            s.put(i, "v", i + 1)
        with self.assertRaises(LWWError) as ctx:
            s.put("overflow", "v", lww.MAX_KEYS + 1)
        self.assertEqual(ctx.exception.code, "KEYSPACE_FULL")

    def test_cli_error_exit_code(self):
        rc, out = run_cli("A", [
            {"op": "put", "key": "k", "value": "x" * 65, "ts": 1},
            {"op": "get", "key": "k"},
            "not used",
        ][:2])
        self.assertEqual(rc, 3)
        self.assertEqual(out[0]["error"], "VALUE_TOO_LARGE")
        self.assertTrue(out[1]["ok"])


if __name__ == "__main__":
    unittest.main()
