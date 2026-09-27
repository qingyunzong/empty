import json
import random
import string
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from merklesync.core import key_order  # noqa: E402


def write_jsonl(path, entries, pretty=False):
    with open(path, "w", encoding="utf-8") as fh:
        for key, value in entries:
            obj = {"key": key, "value": value}
            if pretty:
                fh.write(json.dumps(obj, sort_keys=False, separators=(" ,  ", " : ")))
                fh.write("\n")
            else:
                fh.write(json.dumps(obj, ensure_ascii=False) + "\n")


def run_cli(a_path, b_path, max_rounds=None):
    cmd = [sys.executable, "-m", "merklesync", "diff", str(a_path), str(b_path)]
    if max_rounds is not None:
        cmd += ["--max-rounds", str(max_rounds)]
    return subprocess.run(
        cmd, cwd=REPO_ROOT, capture_output=True, text=True, timeout=60
    )


def reference_diff(a_entries, b_entries):
    """Plain per-key reference diff computed directly from dicts."""
    da = {k: v for k, v in a_entries}
    db = {k: v for k, v in b_entries}
    diff = []
    for key in sorted(set(da) | set(db), key=key_order):
        in_a, in_b = key in da, key in db
        if in_a and in_b:
            if json.dumps(da[key], sort_keys=True) != json.dumps(db[key], sort_keys=True):
                diff.append({"op": "change", "key": key, "a": da[key], "b": db[key]})
        elif in_a:
            diff.append({"op": "remove", "key": key, "value": da[key]})
        else:
            diff.append({"op": "add", "key": key, "value": db[key]})
    return diff


def random_value(rng):
    choice = rng.randrange(4)
    if choice == 0:
        return rng.randrange(-1000, 1000)
    if choice == 1:
        return "".join(rng.choices(string.ascii_letters, k=rng.randrange(1, 10)))
    if choice == 2:
        return {"n": rng.randrange(100), "s": rng.choice(string.ascii_letters)}
    return [rng.randrange(10) for _ in range(rng.randrange(4))]


def random_entries(rng, size):
    keys = rng.sample(range(1, 100000), size)
    keys.sort()
    return [(f"k{key:06d}", random_value(rng)) for key in keys]


def mutate(rng, entries):
    """Randomly add / remove / change entries, keeping keys sorted and unique."""
    mutated = list(entries)
    for _ in range(rng.randrange(1, max(2, len(entries) // 4))):
        op = rng.randrange(3)
        if op == 0 and mutated:
            i = rng.randrange(len(mutated))
            mutated[i] = (mutated[i][0], random_value(rng))
        elif op == 1 and mutated:
            mutated.pop(rng.randrange(len(mutated)))
        else:
            new_key = f"k{rng.randrange(1, 100000):06d}"
            if all(k != new_key for k, _ in mutated):
                mutated.append((new_key, random_value(rng)))
    mutated.sort(key=lambda kv: key_order(kv[0]))
    return mutated


class MerkleSyncCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def make_files(self, a_entries, b_entries, pretty_b=False):
        a_path = self.dir / "a.jsonl"
        b_path = self.dir / "b.jsonl"
        write_jsonl(a_path, a_entries)
        write_jsonl(b_path, b_entries, pretty=pretty_b)
        return a_path, b_path

    # Acceptance A: random diff injection must match the per-key reference diff.
    def test_random_injection_matches_reference(self):
        for seed in range(20):
            with self.subTest(seed=seed):
                rng = random.Random(seed)
                base = random_entries(rng, rng.randrange(2, 120))
                changed = mutate(rng, base)
                a_path, b_path = self.make_files(base, changed)
                proc = run_cli(a_path, b_path, max_rounds=64)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                result = json.loads(proc.stdout)
                expected = reference_diff(base, changed)
                self.assertFalse(result["incomplete"])
                self.assertEqual(result["diff"], expected)
                self.assertEqual(result["equal"], not expected)
                self.assertGreaterEqual(result["rounds"], 1)

    # Acceptance B: whitespace/formatting-only differences must compare equal.
    def test_formatting_only_difference_is_equal(self):
        rng = random.Random(1234)
        entries = random_entries(rng, 60)
        a_path, b_path = self.make_files(entries, entries, pretty_b=True)
        self.assertNotEqual(a_path.read_bytes(), b_path.read_bytes())
        proc = run_cli(a_path, b_path, max_rounds=8)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["equal"])
        self.assertEqual(result["diff"], [])
        self.assertFalse(result["incomplete"])

    # Acceptance C: R=1 must report incomplete without fabricating keys.
    def test_max_rounds_one_is_incomplete(self):
        rng = random.Random(99)
        base = random_entries(rng, 50)
        changed = mutate(rng, base)
        a_path, b_path = self.make_files(base, changed)
        proc = run_cli(a_path, b_path, max_rounds=1)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["incomplete"])
        self.assertFalse(result["equal"])
        self.assertEqual(result["diff"], [])
        self.assertEqual(result["rounds"], 1)
        self.assertGreaterEqual(len(result["suspects"]), 1)
        for suspect in result["suspects"]:
            self.assertIn("a_range", suspect)
            self.assertIn("b_range", suspect)

    # Acceptance D: unsorted input exits with code 3.
    def test_unsorted_input_exits_3(self):
        entries = [("b", 1), ("a", 2)]
        a_path = self.dir / "a.jsonl"
        write_jsonl(a_path, entries)
        b_path = self.dir / "b.jsonl"
        write_jsonl(b_path, [("a", 2), ("b", 1)])
        proc = run_cli(a_path, b_path)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("not in ascending order", proc.stderr)
        self.assertEqual(proc.stdout, "")

    # Acceptance D companion: duplicate keys exit with code 3.
    def test_duplicate_keys_exit_3(self):
        a_path = self.dir / "a.jsonl"
        write_jsonl(a_path, [("a", 1), ("a", 2)])
        b_path = self.dir / "b.jsonl"
        write_jsonl(b_path, [("a", 1)])
        proc = run_cli(a_path, b_path)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("duplicate key", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_identical_files_are_equal(self):
        rng = random.Random(7)
        entries = random_entries(rng, 40)
        a_path, b_path = self.make_files(entries, entries)
        proc = run_cli(a_path, b_path, max_rounds=4)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["equal"])
        self.assertEqual(result["diff"], [])
        self.assertFalse(result["incomplete"])

    def test_empty_files_are_equal(self):
        a_path, b_path = self.make_files([], [])
        proc = run_cli(a_path, b_path, max_rounds=1)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result["equal"])
        self.assertEqual(result["diff"], [])

    def test_single_entry_difference_resolves_at_leaf(self):
        a_path, b_path = self.make_files([("x", 1)], [("x", 2)])
        proc = run_cli(a_path, b_path, max_rounds=1)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result["incomplete"])
        self.assertEqual(
            result["diff"], [{"op": "change", "key": "x", "a": 1, "b": 2}]
        )

    def test_disjoint_streams(self):
        a_path, b_path = self.make_files(
            [("a", 1), ("c", 3)], [("b", 2), ("d", 4)]
        )
        proc = run_cli(a_path, b_path, max_rounds=16)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(
            result["diff"],
            reference_diff([("a", 1), ("c", 3)], [("b", 2), ("d", 4)]),
        )

    def test_invalid_json_exits_2(self):
        a_path = self.dir / "a.jsonl"
        a_path.write_text("{not json}\n")
        b_path = self.dir / "b.jsonl"
        write_jsonl(b_path, [])
        proc = run_cli(a_path, b_path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("invalid JSON", proc.stderr)

    def test_missing_file_exits_2(self):
        b_path = self.dir / "b.jsonl"
        write_jsonl(b_path, [])
        proc = run_cli(self.dir / "nope.jsonl", b_path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("cannot open", proc.stderr)

    def test_limited_rounds_eventually_complete(self):
        rng = random.Random(2024)
        base = random_entries(rng, 80)
        changed = mutate(rng, base)
        a_path, b_path = self.make_files(base, changed)
        expected = reference_diff(base, changed)
        # Binary search the smallest R that still completes.
        lo, hi = 1, 64
        while lo < hi:
            mid = (lo + hi) // 2
            proc = run_cli(a_path, b_path, max_rounds=mid)
            result = json.loads(proc.stdout)
            if result["incomplete"]:
                lo = mid + 1
            else:
                hi = mid
        proc = run_cli(a_path, b_path, max_rounds=lo)
        result = json.loads(proc.stdout)
        self.assertFalse(result["incomplete"])
        self.assertEqual(result["diff"], expected)
        if lo > 1:
            proc = run_cli(a_path, b_path, max_rounds=lo - 1)
            self.assertTrue(json.loads(proc.stdout)["incomplete"])


if __name__ == "__main__":
    unittest.main()
