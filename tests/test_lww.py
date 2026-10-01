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
from lww import LWWRegister

LWW_PY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "lww.py")


def run_cli(lines, node="N1", file_path=None, env_extra=None):
    cmd = [sys.executable, LWW_PY, "--node", node]
    if file_path:
        cmd += ["--file", file_path]
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        cmd, input="\n".join(json.dumps(l) for l in lines) + "\n",
        capture_output=True, text=True, env=env)
    out = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    return proc.returncode, out


def reference_model(ops):
    """Set model: winner per key = max record by (ts, node)."""
    best = {}
    for op in ops:
        key, ts, node, value, tomb = op
        cur = best.get(key)
        if cur is None or (ts, node) > (cur[1], cur[2]):
            best[key] = op
    return {k: op[3] for k, op in best.items() if not op[4]}


def snapshot(register, keys):
    return {k: register.get(k) for k in keys}


class TestMergeOrderEnumeration(unittest.TestCase):
    """A: <=5 keys, <=20 ops; all merge orders agree with the set model."""

    def scenario(self, seed):
        rng = random.Random(seed)
        keys = ["k%d" % i for i in range(5)]
        nodes = ["A", "B", "C"]
        regs = {n: LWWRegister(n) for n in nodes}
        all_ops = []
        for _ in range(20):
            node = rng.choice(nodes)
            key = rng.choice(keys)
            reg = regs[node]
            if rng.random() < 0.3:
                reg.delete(key)
                rec = reg.entries[key]
                all_ops.append((key, rec["ts"], rec["node"], None, True))
            else:
                value = "v%d" % rng.randint(0, 999)
                reg.put(key, value)
                rec = reg.entries[key]
                all_ops.append((key, rec["ts"], rec["node"], value, False))
        return regs, all_ops, keys

    def test_all_merge_orders_match_reference(self):
        for seed in range(10):
            regs, all_ops, keys = self.scenario(seed)
            expected = {k: reference_model(all_ops).get(k) for k in keys}
            states = [r.to_dict() for r in regs.values()]
            for perm in itertools.permutations(range(len(states))):
                merged = LWWRegister("M")
                for i in perm:
                    merged.merge(states[i])
                self.assertEqual(snapshot(merged, keys), expected,
                                 "seed=%d perm=%s" % (seed, perm))

    def test_gossip_converges_and_is_idempotent(self):
        for seed in range(10, 20):
            regs, all_ops, keys = self.scenario(seed)
            expected = {k: reference_model(all_ops).get(k) for k in keys}
            rng = random.Random(seed * 7)
            nodes = list(regs)
            # random gossip rounds until everyone saw everyone
            for _ in range(12):
                src, dst = rng.sample(nodes, 2)
                regs[dst].merge(regs[src].to_dict())
            for n in nodes:
                self.assertEqual(snapshot(regs[n], keys), expected)
                # idempotence: merging own state again changes nothing
                before = regs[n].to_dict()
                regs[n].merge(before)
                self.assertEqual(regs[n].to_dict(), before)

    def test_merge_commutative_associative(self):
        rng = random.Random(99)
        keys = ["a", "b", "c"]
        states = []
        for n in ("X", "Y", "Z"):
            reg = LWWRegister(n)
            for _ in range(6):
                key = rng.choice(keys)
                if rng.random() < 0.4:
                    reg.delete(key)
                else:
                    reg.put(key, "val%d" % rng.randint(0, 50))
            states.append(reg.to_dict())
        s0, s1, s2 = states
        # commutative
        left = LWWRegister("M"); left.merge(s0); left.merge(s1)
        right = LWWRegister("M"); right.merge(s1); right.merge(s0)
        self.assertEqual(left.to_dict()["entries"], right.to_dict()["entries"])
        # associative
        a = LWWRegister("M"); a.merge(s0); a.merge(s1); a.merge(s2)
        b = LWWRegister("M")
        tmp = LWWRegister("T"); tmp.merge(s1); tmp.merge(s2)
        b.merge(s0); b.merge(tmp.to_dict())
        self.assertEqual(a.to_dict()["entries"], b.to_dict()["entries"])


class TestTombstoneSemantics(unittest.TestCase):
    """B: tombstone vs concurrent puts decided by (ts, node) order."""

    def test_tombstone_beats_older_put(self):
        a = LWWRegister("A")
        b = LWWRegister("B")
        for i in range(4):  # B's put lands at ts=4
            b.put("x", "old%d" % i)
        stale = b.to_dict()
        for _ in range(5):  # A's delete lands at ts=5
            a.put("y", "pad")
        a.delete("x")  # tombstone ts=6 > put ts=4... ensure newer
        a.merge(stale)
        self.assertIsNone(a.get("x"))
        self.assertTrue(a.entries["x"]["tomb"])

    def test_concurrent_older_put_loses_to_tombstone(self):
        a = LWWRegister("A")
        b = LWWRegister("B")
        b.put("x", "b1")           # B ts=1
        b.put("x", "b2")           # B ts=2
        older_put = b.to_dict()
        a.put("z", "pad")          # A ts=1
        a.put("z", "pad2")         # A ts=2
        a.delete("x")              # A tombstone ts=3
        a.merge(older_put)         # concurrent put ts=2 < tombstone ts=3
        self.assertIsNone(a.get("x"))
        self.assertTrue(a.entries["x"]["tomb"])

    def test_newer_put_beats_tombstone(self):
        a = LWWRegister("A")
        b = LWWRegister("B")
        a.delete("x")              # A tombstone ts=1
        tomb = a.to_dict()
        b.put("x", "v1")           # B ts=1
        b.put("x", "v2")           # B ts=2 > tombstone ts=1
        b.merge(tomb)
        self.assertEqual(b.get("x"), "v2")
        self.assertFalse(b.entries["x"]["tomb"])

    def test_node_tiebreak(self):
        # same ts, node id decides: ("2","B") > ("2","A")
        a = LWWRegister("A")
        b = LWWRegister("B")
        a.put("x", "fromA")        # (1, "A")
        b.delete("x")              # (1, "B") tombstone wins tie
        a.merge(b.to_dict())
        self.assertIsNone(a.get("x"))
        self.assertTrue(a.entries["x"]["tomb"])

    def test_identical_write_is_idempotent(self):
        a = LWWRegister("A")
        a.put("x", "v")
        state = a.to_dict()
        b = LWWRegister("B")
        b.merge(state)
        b.merge(state)
        self.assertEqual(b.entries["x"], a.entries["x"])


class TestPersistenceCrash(unittest.TestCase):
    """C: crash after temp write, before rename -> old or new file intact."""

    def test_crash_before_rename_keeps_old_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "state.json")
            # initial successful save
            rc, out = run_cli([{"op": "put", "key": "k", "value": "old"},
                               {"op": "save"}], file_path=path)
            self.assertEqual(rc, 0, out)
            with open(path, "rb") as fh:
                old_bytes = fh.read()
            # crash injected after temp write, before rename
            rc, out = run_cli([{"op": "put", "key": "k", "value": "new"},
                               {"op": "save"}], file_path=path,
                              env_extra={"LWW_CRASH_POINT": "before_rename"})
            self.assertEqual(rc, 2)
            # old file fully intact
            with open(path, "rb") as fh:
                self.assertEqual(fh.read(), old_bytes)
            # leftover temp file is complete JSON (never half-written)
            tmps = [f for f in os.listdir(d) if ".tmp." in f]
            self.assertEqual(len(tmps), 1)
            with open(os.path.join(d, tmps[0])) as fh:
                json.loads(fh.read())
            # load recovers old state, checksum passes
            rc, out = run_cli([{"op": "load"},
                               {"op": "get", "key": "k"}], file_path=path)
            self.assertEqual(rc, 0, out)
            self.assertEqual(out[-1]["value"], "old")

    def test_crash_before_first_rename_leaves_no_main_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "state.json")
            rc, _ = run_cli([{"op": "put", "key": "k", "value": "v"},
                             {"op": "save"}], file_path=path,
                            env_extra={"LWW_CRASH_POINT": "before_rename"})
            self.assertEqual(rc, 2)
            self.assertFalse(os.path.exists(path))
            # load of missing file is a clean error, exit 3
            rc, out = run_cli([{"op": "load"}], file_path=path)
            self.assertEqual(rc, 3)
            self.assertEqual(out[-1]["error"], "IO_ERROR")

    def test_successful_save_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "state.json")
            rc, out = run_cli([{"op": "put", "key": "a", "value": "1"},
                               {"op": "put", "key": "b", "value": "2"},
                               {"op": "del", "key": "a"},
                               {"op": "save"}], file_path=path)
            self.assertEqual(rc, 0, out)
            rc, out = run_cli([{"op": "load"},
                               {"op": "get", "key": "a"},
                               {"op": "get", "key": "b"}], file_path=path)
            self.assertEqual(rc, 0, out)
            self.assertIsNone(out[1]["value"])
            self.assertEqual(out[2]["value"], "2")

    def test_corrupt_file_fails_checksum(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "state.json")
            rc, _ = run_cli([{"op": "put", "key": "k", "value": "v"},
                             {"op": "save"}], file_path=path)
            self.assertEqual(rc, 0)
            with open(path, "rb") as fh:
                data = bytearray(fh.read())
            data[len(data) // 2] ^= 0x01
            with open(path, "wb") as fh:
                fh.write(bytes(data))
            rc, out = run_cli([{"op": "load"}], file_path=path)
            self.assertEqual(rc, 3)
            self.assertIn(out[-1]["error"], ("CHECKSUM_MISMATCH",))


class TestGcSafety(unittest.TestCase):
    """D: unsafe gc -> GC_UNSAFE and state unchanged; safe gc collects."""

    def test_unsafe_gc_returns_error_and_keeps_state(self):
        a = LWWRegister("A")
        a.put("x", "v1")
        a.delete("x")                      # tombstone ts=2
        b = LWWRegister("B")
        b.put("y", "unrelated")            # B watermark = 1 < tombstone ts=2
        a.merge(b.to_dict())               # now A knows live replica B
        before = a.to_dict()
        with self.assertRaises(lww.GcUnsafe):
            a.gc(10)
        self.assertEqual(a.to_dict(), before)   # state unchanged

    def test_safe_gc_collects_old_tombstones(self):
        a = LWWRegister("A")
        a.put("x", "v1")
        a.delete("x")                      # tombstone ts=2
        b = LWWRegister("B")
        for i in range(5):
            b.put("y", "p%d" % i)          # B watermark = 5
        a.merge(b.to_dict())               # all replicas past ts=2
        collected = a.gc(3)
        self.assertEqual(collected, 1)
        self.assertNotIn("x", a.entries)
        self.assertIsNone(a.get("x"))

    def test_gc_respects_before_bound(self):
        a = LWWRegister("A")
        a.put("x", "v1")
        a.delete("x")                      # tombstone ts=2
        collected = a.gc(2)                # ts < 2 required
        self.assertEqual(collected, 0)
        self.assertIn("x", a.entries)

    def test_cli_gc_unsafe_exit3(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.json")
            b = LWWRegister("B")
            b.put("y", "pad")
            b_state = b.to_dict()
            rc, out = run_cli([{"op": "put", "key": "x", "value": "v"},
                               {"op": "del", "key": "x"},
                               {"op": "merge", "state": b_state},
                               {"op": "gc", "before": 100},
                               {"op": "dump"}], file_path=path)
            self.assertEqual(rc, 3)
            self.assertEqual(out[-1]["error"], "GC_UNSAFE")


class TestCliAndLimits(unittest.TestCase):

    def test_error_exit_code_3(self):
        rc, out = run_cli([{"op": "put", "key": "k", "value": "x" * 65}])
        self.assertEqual(rc, 3)
        self.assertEqual(out[-1]["error"], "VALUE_TOO_LARGE")

    def test_value_64_bytes_ok(self):
        rc, out = run_cli([{"op": "put", "key": "k", "value": "x" * 64},
                           {"op": "get", "key": "k"}])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out[-1]["value"], "x" * 64)

    def test_unknown_op_and_bad_json(self):
        rc, out = run_cli([{"op": "nope"}])
        self.assertEqual(rc, 3)
        self.assertEqual(out[-1]["error"], "BAD_INPUT")
        proc = subprocess.run([sys.executable, LWW_PY], input="not json\n",
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 3)

    def test_keyspace_limit(self):
        reg = LWWRegister("N")
        reg.MAX_KEYS = 3
        reg.put("a", "1"); reg.put("b", "2"); reg.put("c", "3")
        with self.assertRaises(lww.KeyspaceFull):
            reg.put("d", "4")
        reg.put("a", "again")  # existing key still fine
        self.assertEqual(reg.get("a"), "again")

    def test_merge_via_cli(self):
        a = LWWRegister("A")
        a.put("shared", "fromA")
        rc, out = run_cli([{"op": "merge", "state": a.to_dict()},
                           {"op": "get", "key": "shared"}], node="B")
        self.assertEqual(rc, 0, out)
        self.assertEqual(out[-1]["value"], "fromA")


if __name__ == "__main__":
    unittest.main()
