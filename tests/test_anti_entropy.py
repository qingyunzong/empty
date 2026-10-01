import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import kvstore

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(REPO, "kv.py")


def brute_force_expected(a, b):
    """Full-exchange oracle: classify every key without buckets/digests."""
    pull, push, conflict = set(), set(), set()
    for raw in set(a["data"]) | set(b["data"]):
        key = int(raw)
        ea, eb = a["data"].get(raw), b["data"].get(raw)
        if ea is None:
            pull.add(key)
        elif eb is None:
            push.add(key)
        elif ea == eb:
            continue
        else:
            order = kvstore.compare_versions(ea["version"], eb["version"])
            if order == -1:
                pull.add(key)
            elif order == 1:
                push.add(key)
            else:
                conflict.add(key)
    return pull, push, conflict


def visible_state(store):
    return {int(k): (v["value"], tuple(sorted(v["version"].items())))
            for k, v in store["data"].items()}


class TestRandomAgainstBruteForce(unittest.TestCase):
    """A: random <=50 keys, plan matches full comparison, apply converges."""

    def run_trial(self, rng):
        a = kvstore.empty_store("A")
        b = kvstore.empty_store("B")
        n = rng.randint(0, 50)
        for key in rng.sample(range(256), n):
            action = rng.random()
            if action < 0.35:
                kvstore.put(a, "A", key, f"a{key}")
            elif action < 0.7:
                kvstore.put(b, "B", key, f"b{key}")
            elif action < 0.85:
                # shared history then one side advances (stale on the other)
                kvstore.put(a, "A", key, f"s{key}")
                b["data"][str(key)] = json.loads(json.dumps(a["data"][str(key)]))
                if rng.random() < 0.5:
                    kvstore.put(a, "A", key, f"a{key}2")
                else:
                    kvstore.put(b, "B", key, f"b{key}2")
            else:
                # concurrent writes on both sides
                kvstore.put(a, "A", key, f"a{key}")
                kvstore.put(b, "B", key, f"b{key}")

        plan = kvstore.reconcile(a, b)
        exp_pull, exp_push, exp_conflict = brute_force_expected(a, b)
        self.assertEqual(plan["status"], kvstore.COMPLETE)
        self.assertEqual({op["key"] for op in plan["pull"]}, exp_pull)
        self.assertEqual({op["key"] for op in plan["push"]}, exp_push)
        self.assertEqual({c["key"] for c in plan["conflict"]}, exp_conflict)
        self.assertLessEqual(plan["rounds"], kvstore.DEFAULT_MAX_ROUNDS)
        # message count is monotone in the number of differing buckets
        diff_buckets = len({
            kvstore.bucket_of(k)
            for k in exp_pull | exp_push | exp_conflict})
        if diff_buckets == 0:
            self.assertEqual(plan["messages"], 2)

        kvstore.apply_plan(plan, a, b)
        va, vb = visible_state(a), visible_state(b)
        for key in exp_conflict:
            va.pop(key, None)
            vb.pop(key, None)
        self.assertEqual(va, vb)  # visible state equal outside conflicts
        self.assertEqual(a["conflicts"], b["conflicts"])
        self.assertEqual({c["key"] for c in a["conflicts"]}, exp_conflict)

    def test_random_trials(self):
        rng = random.Random(20261001)
        for _ in range(200):
            self.run_trial(rng)


class TestDigestSemantics(unittest.TestCase):
    def test_empty_bucket_digest_is_zero(self):
        store = kvstore.empty_store("A")
        self.assertEqual(kvstore.bucket_summary(store, 0)["digest"], 0)
        self.assertEqual(kvstore.digest_entries([]), 0)

    def test_digest_deterministic_and_key_order_independent(self):
        s1 = kvstore.empty_store("A")
        s2 = kvstore.empty_store("A")
        kvstore.put(s1, "A", 3, "x")
        kvstore.put(s1, "A", 1, "y")
        kvstore.put(s2, "A", 1, "y")
        kvstore.put(s2, "A", 3, "x")
        self.assertEqual(kvstore.bucket_summary(s1, 0),
                         kvstore.bucket_summary(s2, 0))

    def test_digest_changes_with_value_or_version(self):
        s1 = kvstore.empty_store("A")
        kvstore.put(s1, "A", 5, "x")
        d1 = kvstore.bucket_summary(s1, 0)["digest"]
        kvstore.put(s1, "A", 5, "y")
        d2 = kvstore.bucket_summary(s1, 0)["digest"]
        kvstore.put(s1, "A", 5, "x")
        d3 = kvstore.bucket_summary(s1, 0)["digest"]
        self.assertNotEqual(d1, d2)
        self.assertNotEqual(d1, d3)
        self.assertNotEqual(d2, d3)


class TestBucketHashCollision(unittest.TestCase):
    """B: forced single-bucket digest collision still resolves per key."""

    def test_collision_same_bucket(self):
        a = kvstore.empty_store("A")
        b = kvstore.empty_store("B")
        # same bucket 0, same count, same forced digest, different keys
        kvstore.put(a, "A", 1, "a1")
        kvstore.put(a, "A", 2, "a2")
        kvstore.put(b, "B", 2, "a2")          # identical entry
        kvstore.put(b, "B", 3, "b3")
        kvstore.put(b, "B", 4, "b4")
        # b's copy of key 2 must literally match a's
        b["data"]["2"] = json.loads(json.dumps(a["data"]["2"]))

        real_digest = kvstore.digest_entries
        kvstore.digest_entries = lambda entries: 0xC011  # forced collision
        try:
            sum_a = kvstore.bucket_summary(a, 0)
            sum_b = kvstore.bucket_summary(b, 0)
            self.assertEqual(sum_a["digest"], sum_b["digest"])
            self.assertNotEqual(sum_a, sum_b)  # count/xork still differ
            plan = kvstore.reconcile(a, b)
        finally:
            kvstore.digest_entries = real_digest

        self.assertEqual(plan["status"], kvstore.COMPLETE)
        self.assertEqual({op["key"] for op in plan["pull"]}, {3, 4})
        self.assertEqual({op["key"] for op in plan["push"]}, {1})
        self.assertEqual(plan["conflict"], [])
        kvstore.apply_plan(plan, a, b)
        self.assertEqual(visible_state(a), visible_state(b))

    def test_collision_equal_count(self):
        # Same bucket, same count, forced-equal digest, but different
        # keys: the xork summary field still differs, so the protocol
        # falls back to per-key exchange and resolves correctly.
        a = kvstore.empty_store("A")
        b = kvstore.empty_store("B")
        kvstore.put(a, "A", 1, "a1")
        kvstore.put(a, "A", 2, "a2")
        kvstore.put(b, "B", 4, "b4")
        kvstore.put(b, "B", 5, "b5")
        self.assertEqual(kvstore.bucket_summary(a, 0)["count"],
                         kvstore.bucket_summary(b, 0)["count"])
        self.assertNotEqual(kvstore.bucket_summary(a, 0)["xork"],
                            kvstore.bucket_summary(b, 0)["xork"])
        real_digest = kvstore.digest_entries
        kvstore.digest_entries = lambda entries: 42  # forced collision
        try:
            self.assertEqual(kvstore.bucket_summary(a, 0)["digest"],
                             kvstore.bucket_summary(b, 0)["digest"])
            plan = kvstore.reconcile(a, b)
        finally:
            kvstore.digest_entries = real_digest
        self.assertEqual({op["key"] for op in plan["pull"]}, {4, 5})
        self.assertEqual({op["key"] for op in plan["push"]}, {1, 2})
        kvstore.apply_plan(plan, a, b)
        self.assertEqual(visible_state(a), visible_state(b))


class TestConcurrentConflict(unittest.TestCase):
    """C: concurrent writes to the same key conflict on both sides."""

    def test_concurrent_same_key(self):
        a = kvstore.empty_store("A")
        b = kvstore.empty_store("B")
        kvstore.put(a, "A", 42, "from-a")
        kvstore.put(b, "B", 42, "from-b")
        plan = kvstore.reconcile(a, b)
        self.assertEqual(plan["pull"], [])
        self.assertEqual(plan["push"], [])
        self.assertEqual([c["key"] for c in plan["conflict"]], [42])
        kvstore.apply_plan(plan, a, b)
        # no automatic winner: values untouched
        self.assertEqual(a["data"]["42"]["value"], "from-a")
        self.assertEqual(b["data"]["42"]["value"], "from-b")
        # conflict lists identical on both replicas
        self.assertEqual(a["conflicts"], b["conflicts"])
        self.assertEqual(len(a["conflicts"]), 1)
        self.assertEqual(a["conflicts"][0]["key"], 42)

    def test_comparable_versions_no_conflict(self):
        a = kvstore.empty_store("A")
        b = kvstore.empty_store("B")
        kvstore.put(a, "A", 7, "v1")
        b["data"]["7"] = json.loads(json.dumps(a["data"]["7"]))
        kvstore.put(a, "A", 7, "v2")  # a strictly newer
        plan = kvstore.reconcile(a, b)
        self.assertEqual(plan["conflict"], [])
        self.assertEqual([op["key"] for op in plan["push"]], [7])
        kvstore.apply_plan(plan, a, b)
        self.assertEqual(b["data"]["7"]["value"], "v2")
        self.assertEqual(visible_state(a), visible_state(b))


class TestRoundLimitIncomplete(unittest.TestCase):
    """D: exceeding rounds yields INCOMPLETE with a safe applied prefix."""

    def test_full_keyspace_divergence_exceeds_default_limits(self):
        a = kvstore.empty_store("A")
        b = kvstore.empty_store("B")
        for key in range(256):
            kvstore.put(a, "A", key, f"k{key}")
        plan = kvstore.reconcile(a, b)  # defaults: 8 rounds, 32 keys/round
        self.assertEqual(plan["status"], kvstore.INCOMPLETE)
        self.assertEqual(plan["rounds"], kvstore.DEFAULT_MAX_ROUNDS)
        resolved = len(plan["push"]) + len(plan["pull"])
        # round 1 is digests only; 7 key rounds x 32 keys = 224
        self.assertEqual(resolved, 7 * 32)
        self.assertEqual(len(plan["pending"]), 256 - 224)
        kvstore.apply_plan(plan, a, b)
        pushed = {op["key"] for op in plan["push"]}
        for key in pushed:
            self.assertEqual(a["data"][str(key)], b["data"][str(key)])
        for key in plan["pending"]:  # untouched, not silently dropped
            self.assertNotIn(str(key), b["data"])
        self.assertEqual(len(b["data"]), 224)

    def test_tight_limits_then_followup_completes(self):
        a = kvstore.empty_store("A")
        b = kvstore.empty_store("B")
        for key in range(40):
            kvstore.put(a, "A", key, f"k{key}")
        plan = kvstore.reconcile(a, b, max_rounds=2, max_keys_per_round=16)
        self.assertEqual(plan["status"], kvstore.INCOMPLETE)
        self.assertEqual(len(plan["push"]), 16)
        kvstore.apply_plan(plan, a, b)
        self.assertEqual(len(b["data"]), 16)  # safe prefix retained
        plan2 = kvstore.reconcile(a, b)
        self.assertEqual(plan2["status"], kvstore.COMPLETE)
        kvstore.apply_plan(plan2, a, b)
        self.assertEqual(visible_state(a), visible_state(b))


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.a = os.path.join(self.tmp.name, "a.json")
        self.b = os.path.join(self.tmp.name, "b.json")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *argv, stdin=None):
        return subprocess.run(
            [sys.executable, CLI, *argv],
            capture_output=True, text=True, input=stdin)

    def test_seed_put_digest_reconcile_apply_roundtrip(self):
        r = self.run_cli("seed", self.a, "--replica", "A",
                         "--keys", "20", "--seed", "1")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.run_cli("seed", self.b, "--replica", "B")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.run_cli("put", self.b, "--replica", "B",
                         "--key", "200", "--value", "hello")
        self.assertEqual(r.returncode, 0, r.stderr)
        line = json.loads(r.stdout)
        self.assertEqual(line["version"], {"B": 1})

        r = self.run_cli("digest", self.a, "--bucket", "0")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["bucket"], 0)
        r = self.run_cli("digest", self.b)
        self.assertEqual(len(r.stdout.strip().splitlines()), 16)

        r = self.run_cli("reconcile", self.a, self.b)
        self.assertEqual(r.returncode, 0, r.stderr)
        plan = json.loads(r.stdout)
        self.assertEqual(plan["status"], "COMPLETE")
        self.assertEqual(len(plan["push"]), 20)
        self.assertEqual(len(plan["pull"]), 1)

        plan_path = os.path.join(self.tmp.name, "plan.json")
        with open(plan_path, "w") as fh:
            fh.write(r.stdout)
        r = self.run_cli("apply", self.a, self.b, plan_path)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["applied"], 21)

        r = self.run_cli("reconcile", self.a, self.b)
        plan2 = json.loads(r.stdout)
        self.assertEqual(plan2["messages"], 2)  # digests match: 1 round
        self.assertEqual(plan2["pull"], [])
        self.assertEqual(plan2["push"], [])

    def test_apply_plan_from_stdin(self):
        self.run_cli("seed", self.a, "--replica", "A", "--keys", "5")
        self.run_cli("seed", self.b, "--replica", "B")
        plan = self.run_cli("reconcile", self.a, self.b).stdout
        r = self.run_cli("apply", self.a, self.b, "-", stdin=plan)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["applied"], 5)

    def test_errors_exit_5(self):
        r = self.run_cli("put", self.a, "--replica", "A",
                         "--key", "1", "--value", "x")
        self.assertEqual(r.returncode, 5)  # missing store
        self.run_cli("seed", self.a, "--replica", "A")
        r = self.run_cli("put", self.a, "--replica", "A",
                         "--key", "256", "--value", "x")
        self.assertEqual(r.returncode, 5)  # key out of range
        self.assertIn("error", json.loads(r.stderr))
        r = self.run_cli("put", self.a, "--replica", "A",
                         "--key", "-1", "--value", "x")
        self.assertEqual(r.returncode, 5)
        r = self.run_cli("digest", self.a, "--bucket", "16")
        self.assertEqual(r.returncode, 5)
        r = self.run_cli("apply", self.a, self.a, "/nonexistent/plan.json")
        self.assertEqual(r.returncode, 5)


if __name__ == "__main__":
    unittest.main()
