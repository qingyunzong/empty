"""Acceptance tests A-D plus unit/CLI tests for the kvae anti-entropy tool."""

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from kvae import digest as digest_mod
from kvae import reconcile as reconcile_mod
from kvae import store
from kvae import version

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def brute_force_plan(a, b):
    """Independent full-comparison reference: no buckets, no digests."""
    pull, push, conflict = [], [], []
    for key in range(256):
        ea = a["data"].get(str(key))
        eb = b["data"].get(str(key))
        if ea is None and eb is None:
            continue
        if ea is not None and eb is None:
            push.append(key)
        elif eb is not None and ea is None:
            pull.append(key)
        else:
            rel = version.compare(ea["vv"], eb["vv"])
            if rel == version.GT:
                push.append(key)
            elif rel == version.LT:
                pull.append(key)
            elif rel == version.CONCURRENT:
                conflict.append(key)
    return {"pull": pull, "push": push, "conflict": conflict}


def assert_consistent(testcase, a, b):
    """Visible state equal, or conflict lists equal covering every divergence."""
    ca = a["conflicts"]
    cb = b["conflicts"]
    testcase.assertEqual(ca, cb, "conflict lists must be identical on both replicas")
    conflict_keys = {c["key"] for c in ca}
    for key in range(256):
        ea = a["data"].get(str(key))
        eb = b["data"].get(str(key))
        if key in conflict_keys:
            continue
        testcase.assertEqual(ea, eb, f"key {key} diverged without a conflict entry")


def make_diverged_pair(rng, max_keys=50):
    """Two replicas with shared history then divergent writes (<=max_keys total)."""
    a = store.new_replica("A")
    b = store.new_replica("B")
    keys = rng.sample(range(256), rng.randrange(0, max_keys + 1))
    for key in keys:
        fate = rng.randrange(5)
        if fate == 0:  # only A
            store.put(a, key, f"a{key}")
        elif fate == 1:  # only B
            store.put(b, key, f"b{key}")
        elif fate == 2:  # shared history, A advances -> A dominates
            store.put(a, key, "base")
            b["data"][str(key)] = json.loads(json.dumps(a["data"][str(key)]))
            store.put(a, key, "a-newer")
        elif fate == 3:  # shared history, B advances -> B dominates
            store.put(a, key, "base")
            b["data"][str(key)] = json.loads(json.dumps(a["data"][str(key)]))
            store.put(b, key, "b-newer")
        else:  # concurrent writes
            store.put(a, key, "base")
            b["data"][str(key)] = json.loads(json.dumps(a["data"][str(key)]))
            store.put(a, key, "a-fork")
            store.put(b, key, "b-fork")
    return a, b


class TestDigest(unittest.TestCase):
    def test_empty_bucket_is_zero(self):
        self.assertEqual(digest_mod.bucket_digest([]), 0)
        rep = store.new_replica("A")
        self.assertEqual(digest_mod.replica_digests(rep), [0] * 16)

    def test_deterministic_and_order_independent(self):
        entries = [(k, {"value": f"v{k}", "vv": {"A": k + 1}}) for k in range(16)]
        d1 = digest_mod.bucket_digest(entries)
        d2 = digest_mod.bucket_digest(list(reversed(entries)))
        self.assertEqual(d1, d2)
        self.assertNotEqual(d1, 0)

    def test_version_change_changes_digest(self):
        e1 = [(1, {"value": "x", "vv": {"A": 1}})]
        e2 = [(1, {"value": "x", "vv": {"A": 2}})]
        self.assertNotEqual(digest_mod.bucket_digest(e1), digest_mod.bucket_digest(e2))

    def test_bucket_layout(self):
        self.assertEqual(digest_mod.bucket_of(0), 0)
        self.assertEqual(digest_mod.bucket_of(15), 0)
        self.assertEqual(digest_mod.bucket_of(16), 1)
        self.assertEqual(digest_mod.bucket_of(255), 15)


class TestVersionVector(unittest.TestCase):
    def test_relations(self):
        self.assertEqual(version.compare({"A": 1}, {"A": 1}), version.EQ)
        self.assertEqual(version.compare({"A": 2}, {"A": 1}), version.GT)
        self.assertEqual(version.compare({"A": 1}, {"A": 2}), version.LT)
        self.assertEqual(version.compare({"A": 1}, {"B": 1}), version.CONCURRENT)
        self.assertEqual(version.compare({"A": 2, "B": 1}, {"A": 1, "B": 1}), version.GT)
        self.assertEqual(version.compare({"A": 2}, {"A": 1, "B": 1}), version.CONCURRENT)


class TestAcceptanceA(unittest.TestCase):
    """A: random <=50 keys, plan matches brute-force full comparison, and
    applying the plan converges both replicas."""

    def test_random_against_brute_force(self):
        for seed in range(30):
            rng = random.Random(seed)
            a, b = make_diverged_pair(rng)
            expected = brute_force_plan(a, b)
            plan = reconcile_mod.build_plan(a, b)
            self.assertEqual(plan["status"], "OK", f"seed={seed}")
            self.assertEqual(sorted(e["key"] for e in plan["pull"]), expected["pull"])
            self.assertEqual(sorted(e["key"] for e in plan["push"]), expected["push"])
            self.assertEqual(sorted(c["key"] for c in plan["conflict"]), expected["conflict"])
            reconcile_mod.apply_plan(a, b, plan)
            assert_consistent(self, a, b)

    def test_message_count_monotonic_in_bucket_diffs(self):
        counts = []
        for extra_buckets in range(4):
            a = store.new_replica("A")
            b = store.new_replica("B")
            for bk in range(extra_buckets + 1):
                store.put(a, bk * 16, f"k{bk}")  # one differing key per bucket
            plan = reconcile_mod.build_plan(a, b)
            counts.append(plan["messages"])
        self.assertEqual(counts, sorted(counts))
        self.assertLess(counts[0], counts[-1])


class TestAcceptanceB(unittest.TestCase):
    """B: 16 keys colliding into a single bucket are still resolved key-by-key."""

    def test_single_bucket_collision_resolved_per_key(self):
        a = store.new_replica("A")
        b = store.new_replica("B")
        # all 16 keys of bucket 0 -> maximal bucketization collision
        for key in range(0, 3):      # only in A
            store.put(a, key, f"a{key}")
        for key in range(3, 6):      # only in B
            store.put(b, key, f"b{key}")
        for key in range(6, 8):      # A newer
            store.put(a, key, "base")
            b["data"][str(key)] = json.loads(json.dumps(a["data"][str(key)]))
            store.put(a, key, "a-newer")
        for key in range(8, 10):     # B newer
            store.put(a, key, "base")
            b["data"][str(key)] = json.loads(json.dumps(a["data"][str(key)]))
            store.put(b, key, "b-newer")
        for key in range(10, 12):    # concurrent
            store.put(a, key, "base")
            b["data"][str(key)] = json.loads(json.dumps(a["data"][str(key)]))
            store.put(a, key, "a-fork")
            store.put(b, key, "b-fork")
        for key in range(12, 16):    # identical
            store.put(a, key, "same")
            b["data"][str(key)] = json.loads(json.dumps(a["data"][str(key)]))

        dig_a = digest_mod.replica_digests(a)
        dig_b = digest_mod.replica_digests(b)
        self.assertNotEqual(dig_a[0], dig_b[0])
        self.assertEqual(dig_a[1:], dig_b[1:])  # exactly one bucket differs

        plan = reconcile_mod.build_plan(a, b)
        self.assertEqual(plan["status"], "OK")
        self.assertEqual(sorted(e["key"] for e in plan["push"]), [0, 1, 2, 6, 7])
        self.assertEqual(sorted(e["key"] for e in plan["pull"]), [3, 4, 5, 8, 9])
        self.assertEqual(sorted(c["key"] for c in plan["conflict"]), [10, 11])

        reconcile_mod.apply_plan(a, b, plan)
        assert_consistent(self, a, b)
        for key in range(12, 16):  # identical keys untouched and equal
            self.assertEqual(a["data"][str(key)], b["data"][str(key)])


class TestAcceptanceC(unittest.TestCase):
    """C: concurrent writes on the same key -> conflict on both sides, no winner."""

    def test_concurrent_same_key_conflicts_symmetrically(self):
        a = store.new_replica("A")
        b = store.new_replica("B")
        store.put(a, 42, "alpha")
        store.put(b, 42, "beta")

        plan = reconcile_mod.build_plan(a, b)
        self.assertEqual(plan["status"], "OK")
        self.assertEqual(plan["pull"], [])
        self.assertEqual(plan["push"], [])
        self.assertEqual([c["key"] for c in plan["conflict"]], [42])
        conflict = plan["conflict"][0]
        self.assertEqual(conflict["a"]["value"], "alpha")
        self.assertEqual(conflict["b"]["value"], "beta")

        summary = reconcile_mod.apply_plan(a, b, plan)
        self.assertEqual(summary["applied"], 0)
        # no automatic winner: each side keeps its own value
        self.assertEqual(a["data"]["42"]["value"], "alpha")
        self.assertEqual(b["data"]["42"]["value"], "beta")
        # conflict lists identical on both replicas
        self.assertEqual(a["conflicts"], b["conflicts"])
        self.assertEqual([c["key"] for c in a["conflicts"]], [42])


class TestAcceptanceD(unittest.TestCase):
    """D: exceeding the round budget -> INCOMPLETE with a safe applied prefix."""

    def test_incomplete_when_rounds_exceeded(self):
        a = store.new_replica("A")
        b = store.new_replica("B")
        for key in range(256):  # every key concurrent: 32 summaries per bucket
            store.put(a, key, f"a{key}")
            store.put(b, key, f"b{key}")
        a_before = json.loads(json.dumps(a["data"]))
        b_before = json.loads(json.dumps(b["data"]))

        plan = reconcile_mod.build_plan(a, b)  # 8 rounds x 32 keys = 256 budget
        self.assertEqual(plan["status"], "INCOMPLETE")
        self.assertLessEqual(plan["rounds"], 8)
        self.assertLessEqual(plan["messages"], 8 * 32)
        self.assertEqual(plan["pending_buckets"], list(range(8, 16)))
        self.assertEqual(len(plan["conflict"]), 8 * 16)  # 8 processed buckets

        summary = reconcile_mod.apply_plan(a, b, plan)
        self.assertEqual(summary["status"], "INCOMPLETE")
        self.assertEqual(summary["applied"], 0)  # all concurrent -> conflicts
        self.assertEqual(a["conflicts"], b["conflicts"])
        self.assertEqual(len(a["conflicts"]), 128)

        # safe prefix: processed buckets' conflicts recorded; pending buckets
        # left completely untouched on both replicas
        for key in range(128, 256):
            self.assertEqual(a["data"][str(key)], a_before[str(key)])
            self.assertEqual(b["data"][str(key)], b_before[str(key)])

    def test_incomplete_never_claims_success(self):
        a = store.new_replica("A")
        b = store.new_replica("B")
        for key in range(256):
            store.put(a, key, f"a{key}")
            store.put(b, key, f"b{key}")
        plan = reconcile_mod.build_plan(a, b, max_rounds=2, max_keys_per_round=16)
        self.assertEqual(plan["status"], "INCOMPLETE")
        self.assertNotEqual(plan["status"], "OK")


class TestCli(unittest.TestCase):
    def run_cli(self, *argv, expect_code=0):
        proc = subprocess.run(
            [sys.executable, "-m", "kvae", *argv],
            capture_output=True, text=True, cwd=REPO_ROOT,
        )
        self.assertEqual(
            proc.returncode, expect_code,
            f"argv={argv}\nstdout={proc.stdout}\nstderr={proc.stderr}",
        )
        return proc

    def test_full_flow_and_error_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            ra = os.path.join(tmp, "a.json")
            rb = os.path.join(tmp, "b.json")
            plan_path = os.path.join(tmp, "plan.json")

            self.run_cli("seed", "--replica", ra, "--id", "A", "--keys", "20", "--seed", "7")
            self.run_cli("seed", "--replica", rb, "--id", "B", "--keys", "0")
            self.run_cli("put", "--replica", ra, "--key", "200", "--value", "hello")

            out = self.run_cli("reconcile", "--a", ra, "--b", rb,
                               "--plan-out", plan_path)
            plan = json.loads(out.stdout)
            self.assertEqual(plan["status"], "OK")
            self.assertEqual(len(plan["push"]), 21)

            out = self.run_cli("apply", "--a", ra, "--b", rb, "--plan", plan_path)
            self.assertTrue(json.loads(out.stdout)["ok"])

            dig_a = [json.loads(l)["digest"] for l in
                     self.run_cli("digest", "--replica", ra).stdout.splitlines()]
            dig_b = [json.loads(l)["digest"] for l in
                     self.run_cli("digest", "--replica", rb).stdout.splitlines()]
            self.assertEqual(dig_a, dig_b)

            # errors exit with code 5
            self.run_cli("put", "--replica", ra, "--key", "300",
                         "--value", "x", expect_code=5)
            self.run_cli("digest", "--replica", os.path.join(tmp, "nope.json"),
                         expect_code=5)
            self.run_cli("digest", "--replica", ra, "--bucket", "16", expect_code=5)


if __name__ == "__main__":
    unittest.main()
