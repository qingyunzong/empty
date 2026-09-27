import itertools
import json
import os
import subprocess
import sys
import tempfile
import unittest
from random import Random

from budgetsync import core
from budgetsync.__main__ import main as cli_main


# ---------------------------------------------------------------------------
# Independent reference implementation (intentionally does not reuse core).
# ---------------------------------------------------------------------------

def ref_equal(left, right):
    """Type-safe JSON equality: booleans distinct from ints, -0.0 == 0.0."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, dict) or isinstance(right, dict):
        return (
            isinstance(left, dict)
            and isinstance(right, dict)
            and left.keys() == right.keys()
            and all(ref_equal(left[k], right[k]) for k in left)
        )
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list)
            and isinstance(right, list)
            and len(left) == len(right)
            and all(ref_equal(a, b) for a, b in zip(left, right))
        )
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    if left is None or right is None:
        return left is None and right is None
    return left == right


def ref_candidates(a, b):
    """Candidate repairs sorted by (key, op rank) with rank delete=0 set=1."""
    candidates = []
    for key in sorted(set(a) | set(b)):
        if key not in a:
            candidates.append((key, 0, {"op": "delete", "key": key}))
        elif key not in b or not ref_equal(a[key], b[key]):
            candidates.append(
                (key, 1, {"op": "set", "key": key, "value": a[key]})
            )
    return candidates


def ref_apply(state, ops):
    result = dict(state)
    for op in ops:
        if op["op"] == "set":
            result[op["key"]] = op["value"]
        else:
            result.pop(op["key"], None)
    return result


def ref_gain(a, state, ops):
    """Absolute matched-field count after applying *ops*.

    Each top-level key in the union is a field.  It matches when the value
    equals A or the key exists in neither side (rule 3).  Thus a set on a
    mismatched key and a delete on a surplus key each repair exactly one
    field; untouched mismatches and surplus keys contribute nothing.
    """
    fixed = ref_apply(state, ops)
    count = 0
    for key in set(a) | set(state):
        if key in a:
            if key in fixed and ref_equal(a[key], fixed[key]):
                count += 1
        elif key not in fixed:
            count += 1
    return count


def brute_force_optimum(a, b, budget):
    """Enumerate every feasible repair subset.

    Returns ``(max_gain, best_key)`` where ``max_gain`` is the number of
    matched fields after repair (absolute) and ``best_key`` is the smallest
    ``(key, op-rank)`` set among all maximum-gain plans.
    """
    candidates = ref_candidates(a, b)
    best_gain = None
    best_key = None
    for size in range(0, min(budget, len(candidates)) + 1):
        for subset in itertools.combinations(candidates, size):
            ops = [item[2] for item in subset]
            gain = ref_gain(a, b, ops)
            key = tuple((k, rank) for k, rank, _ in subset)
            if best_gain is None or gain > best_gain or (
                gain == best_gain and key < best_key
            ):
                best_gain = gain
                best_key = key
    return best_gain, best_key


def plan_key(plan):
    rank = {"delete": 0, "set": 1}
    return tuple(sorted((op["key"], rank[op["op"]]) for op in plan))


VALUES = [
    1,
    0,
    0.0,
    -0.0,
    "x",
    None,
    True,
    False,
    [1, -0.0, {"z": 0.0}],
    {"nested": [True, 0], "f": -0.0},
    {"a": 1, "b": [2, 3]},
]


def make_states(n, seed):
    rng = Random(seed * 1000 + n)
    a, b = {}, {}
    for i in range(n):
        key = f"k{i:02d}"
        mode = rng.randrange(7)
        v1 = rng.choice(VALUES)
        v2 = rng.choice(VALUES)
        if mode == 0:  # equal shallow value
            a[key] = v1
            b[key] = v1
        elif mode == 1:  # equal nested value (different object identity)
            a[key] = json.loads(json.dumps(v1))
            b[key] = json.loads(json.dumps(v1))
        elif mode == 2:  # equal only numerically (-0.0 vs 0.0)
            a[key] = -0.0
            b[key] = 0.0
        elif mode == 3:  # differing values
            a[key] = v1
            b[key] = v2 if not ref_equal(v1, v2) else "different"
        elif mode == 4:  # target only -> set
            a[key] = v1
        elif mode == 5:  # current only -> delete
            b[key] = v1
        else:  # bool vs int must not compare equal
            a[key] = True
            b[key] = 1
    return a, b


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class ExhaustiveOptimumTests(unittest.TestCase):
    """Acceptance A: enumerate all subsets for n <= 12."""

    def test_optimum_and_tie_break_for_all_key_subsets(self):
        for n in range(0, 13):
            for seed in range(4):
                a, b = make_states(n, seed)
                candidates = ref_candidates(a, b)
                budgets = {0, 1, n // 2, len(candidates), len(candidates) + 2}
                for budget in budgets:
                    with self.subTest(n=n, seed=seed, budget=budget):
                        plan, info = core.build_plan(a, b, budget)
                        self.assertLessEqual(len(plan), budget)
                        expect_gain, expect_key = brute_force_optimum(
                            a, b, budget
                        )
                        self.assertEqual(ref_gain(a, b, plan), expect_gain)
                        self.assertEqual(plan_key(plan), expect_key)
                        self.assertEqual(info["selected"], len(plan))
                        self.assertEqual(info["budget"], budget)
                        self.assertEqual(
                            info["remaining"], budget - len(plan)
                        )

    def test_ordering_delete_before_set(self):
        # Keys chosen so that without the op rule a set on a smaller key
        # could win; budget 1 forces a single tie-broken choice.
        a = {"ak": 1, "zk": 9}
        b = {"ak": 2, "bk": 5}
        plan, _ = core.build_plan(a, b, 1)
        # Candidates sorted: ("ak", set), ("bk", delete), ("zk", set).
        self.assertEqual(plan, [{"op": "set", "key": "ak", "value": 1}])

        a = {"mk": 1}
        b = {"ak": 0, "mk": 2}
        plan, _ = core.build_plan(a, b, 1)
        self.assertEqual(plan, [{"op": "delete", "key": "ak"}])

    def test_full_budget_converges(self):
        for n in range(0, 13):
            a, b = make_states(n, 99)
            plan, info = core.build_plan(a, b, len(a) + len(b) + 5)
            final = core.apply_plan(b, plan)
            self.assertTrue(core.matches(a, final))
            self.assertEqual(info["remaining"], info["budget"] - len(plan))


class SemanticsTests(unittest.TestCase):
    def test_budget_zero_empty_plan(self):
        a, b = make_states(8, 7)
        plan, info = core.build_plan(a, b, 0)
        self.assertEqual(plan, [])
        self.assertEqual(info, {"selected": 0, "budget": 0, "remaining": 0})

    def test_no_mismatches_empty_plan_any_budget(self):
        a = {"x": [1, {"y": -0.0}]}
        plan, info = core.build_plan(a, json.loads(json.dumps(a)), 3)
        self.assertEqual(plan, [])
        self.assertEqual(info["remaining"], 3)

    def test_nested_normalization_and_negative_zero(self):
        a = {"v": {"x": [1, 2, -0.0], "y": None}}
        b = {"v": {"x": [1, 2, 0.0], "y": None}}
        self.assertTrue(core.values_equal(a["v"], b["v"]))
        plan, _ = core.build_plan(a, b, 5)
        self.assertEqual(plan, [])
        # A genuine nested difference requires one wholesale set (no partial).
        b2 = {"v": {"x": [1, 9, 0.0], "y": None}}
        plan, _ = core.build_plan(a, b2, 5)
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["op"], "set")
        final = core.apply_plan(b2, plan)
        self.assertTrue(core.matches(a, final))

    def test_bool_not_equal_to_int(self):
        self.assertFalse(core.values_equal(True, 1))
        self.assertFalse(core.values_equal(False, 0))
        plan, _ = core.build_plan({"k": True}, {"k": 1}, 1)
        self.assertEqual(len(plan), 1)

    def test_no_partial_set_value_is_whole_field(self):
        a = {"v": {"x": 1, "y": 2}}
        b = {"v": {"x": 1, "y": 3}}
        plan, _ = core.build_plan(a, b, 1)
        self.assertEqual(plan[0]["value"], {"x": 1, "y": 2})

    def test_negative_budget_raises(self):
        with self.assertRaises(core.BudgetError):
            core.build_plan({"a": 1}, {}, -1)

    def test_non_object_raises(self):
        for bad in ([1, 2], "str", 5, None, True):
            with self.subTest(bad=bad):
                with self.assertRaises(core.NotAnObjectError):
                    core.build_plan(bad, {}, 1)
                with self.assertRaises(core.NotAnObjectError):
                    core.build_plan({}, bad, 1)


class IdempotencyTests(unittest.TestCase):
    def test_plan_idempotent(self):
        for n in range(0, 13):
            for seed in range(3):
                a, b = make_states(n, seed)
                plan, _ = core.build_plan(a, b, n // 2 + 1)
                once = core.apply_plan(b, plan)
                twice = core.apply_plan(once, plan)
                thrice = core.apply_plan(twice, plan)
                self.assertEqual(once, twice)
                self.assertEqual(twice, thrice)

    def test_full_plan_reaches_fixed_point(self):
        a, b = make_states(10, 42)
        plan, _ = core.build_plan(a, b, 100)
        final = core.apply_plan(b, plan)
        self.assertEqual(core.apply_plan(final, plan), final)
        self.assertTrue(core.matches(a, final))


class CliTests(unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "budgetsync", *argv],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def _write(self, tmp, name, data):
        path = os.path.join(tmp, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        return path

    def test_plan_outputs_jsonl_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            ap = self._write(tmp, "a.json", {"ak": 1, "zk": 2})
            bp = self._write(tmp, "b.json", {"ak": 9, "bk": 3})
            out = os.path.join(tmp, "plan.jsonl")
            proc = self.run_cli("plan", ap, bp, "--budget", "3", "--out", out)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            summary = json.loads(proc.stdout.strip())
            self.assertEqual(
                summary, {"selected": 3, "budget": 3, "remaining": 0}
            )
            with open(out, encoding="utf-8") as handle:
                lines = [json.loads(line) for line in handle if line.strip()]
            self.assertEqual(
                lines,
                [
                    {"op": "set", "key": "ak", "value": 1},
                    {"op": "delete", "key": "bk"},
                    {"op": "set", "key": "zk", "value": 2},
                ],
            )

            # Round-trip through the apply subcommand.
            state_out = os.path.join(tmp, "fixed.json")
            proc = self.run_cli("apply", out, bp, "--out", state_out)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(state_out, encoding="utf-8") as handle:
                self.assertEqual(
                    json.load(handle), {"ak": 1, "zk": 2}
                )

    def test_budget_zero_writes_empty_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            ap = self._write(tmp, "a.json", {"x": 1})
            bp = self._write(tmp, "b.json", {"x": 2, "y": 3})
            out = os.path.join(tmp, "plan.jsonl")
            proc = self.run_cli("plan", ap, bp, "--budget", "0", "--out", out)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(
                json.loads(proc.stdout.strip()),
                {"selected": 0, "budget": 0, "remaining": 0},
            )
            self.assertEqual(os.path.getsize(out), 0)

    def test_negative_budget_exit_code_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            ap = self._write(tmp, "a.json", {"x": 1})
            bp = self._write(tmp, "b.json", {})
            out = os.path.join(tmp, "plan.jsonl")
            proc = self.run_cli("plan", ap, bp, "--budget", "-3", "--out", out)
            self.assertEqual(proc.returncode, 2)

    def test_non_object_exit_code_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "plan.jsonl")
            bad = self._write(tmp, "bad.json", [1, 2, 3])
            good = self._write(tmp, "good.json", {"x": 1})
            proc = self.run_cli("plan", bad, good, "--budget", "1", "--out", out)
            self.assertEqual(proc.returncode, 3)
            proc = self.run_cli("plan", good, bad, "--budget", "1", "--out", out)
            self.assertEqual(proc.returncode, 3)


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
