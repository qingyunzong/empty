"""Acceptance and unit tests for detrand.

Run with: python -m unittest discover -s tests -v
"""

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from detrand.engine import Stream, canonical  # noqa: E402
from detrand.spec import validate  # noqa: E402
from detrand.errors import SpecError  # noqa: E402

COUNTER_SPEC = {
    "states": ["idle", "running", "done"],
    "initial": "idle",
    "vars": {"count": 0},
    "transitions": {
        "idle": ["start"],
        "running": ["bump", "pick", "burst", "finish"],
        "done": [],
    },
    "ops": {
        "start": {"to": "running"},
        "bump": {
            "to": "running",
            "args": {"n": {"kind": "int", "lo": 1, "hi": 5}},
            "effect": "count += n",
        },
        "pick": {
            "to": "running",
            "args": {"c": {"kind": "choice", "options": ["x", "y", "z"]}},
        },
        "burst": {"to": "running", "fork": {"name": "burst", "draws": 3}},
        "finish": {"to": "done", "guard": "count >= 20"},
    },
    "invariants": ["count >= 0", "count <= 100"],
}

FORK_SPEC = {
    "states": ["gen", "fork"],
    "initial": "gen",
    "vars": {},
    "transitions": {"gen": ["gen_op"], "fork": ["fork_op"]},
    "ops": {
        "gen_op": {"to": "fork", "args": {"n": {"kind": "int", "lo": 0, "hi": 999}}},
        "fork_op": {"to": "gen", "fork": {"name": "sub", "draws": 2}},
    },
    "invariants": [],
}

FAILING_SPEC = {
    "states": ["s"],
    "initial": "s",
    "vars": {"count": 0},
    "transitions": {"s": ["bump"]},
    "ops": {
        "bump": {
            "to": "s",
            "args": {"n": {"kind": "int", "lo": 1, "hi": 5}},
            "effect": "count += n",
        }
    },
    "invariants": ["count <= 10"],
}


def run_cli(*argv, cwd, hashseed="0"):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT)
    env["PYTHONHASHSEED"] = hashseed
    return subprocess.run(
        [sys.executable, "-m", "detrand", *argv],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
    )


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line]


class DetrandTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def write_spec(self, spec, name="spec.json"):
        path = self.dir / name
        path.write_text(json.dumps(spec))
        return str(path)


class TestDeterminism(DetrandTestCase):
    def test_a_same_seed_same_spec_byte_identical_across_processes(self):
        spec = self.write_spec(COUNTER_SPEC)
        outputs = []
        for i, hashseed in enumerate(("0", "1", "12345")):
            record = self.dir / f"run{i}.jsonl"
            proc = run_cli(
                "run", spec, "--seed", "7", "--steps", "200",
                "--record", str(record),
                cwd=self.dir, hashseed=hashseed,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            outputs.append(record.read_bytes())
        self.assertEqual(outputs[0], outputs[1], "PYTHONHASHSEED must not matter")
        self.assertEqual(outputs[0], outputs[2], "runs must be byte identical")

    def test_different_seed_differs(self):
        spec = self.write_spec(COUNTER_SPEC)
        records = []
        for seed in ("7", "8"):
            record = self.dir / f"seed{seed}.jsonl"
            proc = run_cli(
                "run", spec, "--seed", seed, "--steps", "50",
                "--record", str(record), cwd=self.dir,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            records.append(record.read_bytes())
        self.assertNotEqual(records[0], records[1])


class TestFork(DetrandTestCase):
    def test_b_fork_does_not_consume_parent_stream(self):
        spec = self.write_spec(FORK_SPEC)
        record = self.dir / "fork.jsonl"
        seed = 7
        proc = run_cli(
            "run", spec, "--seed", str(seed), "--steps", "6",
            "--record", str(record), cwd=self.dir,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        steps = [l for l in read_jsonl(record) if l["type"] == "step"]
        self.assertEqual([s["op"] for s in steps],
                         ["gen_op", "fork_op"] * 3)

        # Hand-made reference: the parent stream is exactly
        # random.Random(seed) drawing randint(0, 999) per gen_op.
        reference = random.Random(seed)
        expected_ns = [reference.randint(0, 999) for _ in range(3)]
        actual_ns = [s["args"]["n"] for s in steps if s["op"] == "gen_op"]
        self.assertEqual(actual_ns, expected_ns,
                         "fork must not disturb the parent random sequence")

        # Fork children are derived from (seed, parent position, name).
        # Each gen_op consumes exactly one parent draw, so the forks
        # happen at parent positions 1, 2, 3.
        fork_steps = [s for s in steps if s["op"] == "fork_op"]
        for position, step in zip((1, 2, 3), fork_steps):
            child = Stream(seed)
            child.position = position
            derived = child.fork("sub")
            expected_results = [derived.randrange(2**32) for _ in range(2)]
            self.assertEqual(step["args"]["fork_results"], expected_results)
            self.assertEqual(step["args"]["fork"], "sub")

    def test_fork_is_deterministic_across_processes(self):
        spec = self.write_spec(FORK_SPEC)
        outputs = []
        for i, hashseed in enumerate(("3", "99")):
            record = self.dir / f"fork{i}.jsonl"
            proc = run_cli(
                "run", spec, "--seed", "11", "--steps", "10",
                "--record", str(record), cwd=self.dir, hashseed=hashseed,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            outputs.append(record.read_bytes())
        self.assertEqual(outputs[0], outputs[1])


class TestReplay(DetrandTestCase):
    def _run_ok(self, spec_obj=COUNTER_SPEC, seed="7", steps="60"):
        spec = self.write_spec(spec_obj)
        record = self.dir / "run.jsonl"
        proc = run_cli(
            "run", spec, "--seed", seed, "--steps", steps,
            "--record", str(record), cwd=self.dir,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return record

    def test_replay_clean_record(self):
        record = self._run_ok()
        proc = run_cli("replay", str(record), cwd=self.dir, hashseed="77")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("replay ok", proc.stdout)

    def test_c_tampered_step_exits_4(self):
        record = self._run_ok()
        lines = read_jsonl(record)
        step_lines = [l for l in lines if l["type"] == "step"]
        target, key = next(
            (l, k)
            for l in step_lines
            for k, v in l["args"].items()
            if isinstance(v, int)
        )
        target["args"][key] += 1
        record.write_text("".join(json.dumps(l) + "\n" for l in lines))
        proc = run_cli("replay", str(record), cwd=self.dir)
        self.assertEqual(proc.returncode, 4, proc.stderr)
        self.assertIn("E_DIVERGE", proc.stderr)

    def test_tampered_digest_exits_4(self):
        record = self._run_ok()
        lines = read_jsonl(record)
        target = next(l for l in lines if l["type"] == "step")
        target["digest"] = "0" * 64
        record.write_text("".join(json.dumps(l) + "\n" for l in lines))
        proc = run_cli("replay", str(record), cwd=self.dir)
        self.assertEqual(proc.returncode, 4, proc.stderr)
        self.assertIn("E_DIVERGE", proc.stderr)

    def test_truncated_record_exits_4(self):
        record = self._run_ok()
        lines = read_jsonl(record)
        # Drop a step line from the middle but keep header and result.
        del lines[2]
        record.write_text("".join(json.dumps(l) + "\n" for l in lines))
        proc = run_cli("replay", str(record), cwd=self.dir)
        self.assertEqual(proc.returncode, 4, proc.stderr)
        self.assertIn("E_DIVERGE", proc.stderr)

    def test_garbage_record_exits_3(self):
        bad = self.dir / "garbage.jsonl"
        bad.write_text("this is not json\n")
        proc = run_cli("replay", str(bad), cwd=self.dir)
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertIn("E_REPLAY", proc.stderr)

    def test_missing_record_exits_3(self):
        proc = run_cli("replay", str(self.dir / "nope.jsonl"), cwd=self.dir)
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertIn("E_REPLAY", proc.stderr)


class TestInvariantFailure(DetrandTestCase):
    def test_d_failure_archived_and_reproducible(self):
        spec = self.write_spec(FAILING_SPEC)
        record = self.dir / "fail_run.jsonl"
        failure = self.dir / "failure.json"
        proc = run_cli(
            "run", spec, "--seed", "7", "--steps", "200",
            "--record", str(record), "--failure", str(failure), cwd=self.dir,
        )
        self.assertEqual(proc.returncode, 5, proc.stderr)
        self.assertIn("E_INVARIANT", proc.stderr)

        archive = json.loads(failure.read_text())
        self.assertEqual(archive["seed"], 7)
        self.assertIn("count <= 10", archive["invariant"])
        self.assertTrue(archive["path"], "path must list the ops taken")
        self.assertEqual(archive["path"][-1]["step"], archive["step"])
        self.assertRegex(archive["last_digest"], r"^[0-9a-f]{64}$")

        lines = read_jsonl(record)
        self.assertEqual(lines[-1]["status"], "invariant_violation")
        self.assertEqual(lines[-1]["last_digest"], archive["last_digest"])
        self.assertEqual(len(archive["path"]), lines[-1]["steps_run"])

        # The archived failure is reproducible by replay, in any process.
        replay = run_cli("replay", str(record), cwd=self.dir, hashseed="31415")
        self.assertEqual(replay.returncode, 5, replay.stderr)
        self.assertIn("E_INVARIANT", replay.stderr)
        self.assertIn("reproduced", replay.stderr)

    def test_replay_diverges_if_failure_not_reproduced(self):
        spec = self.write_spec(FAILING_SPEC)
        record = self.dir / "fail_run.jsonl"
        proc = run_cli(
            "run", spec, "--seed", "7", "--steps", "200",
            "--record", str(record), cwd=self.dir,
        )
        self.assertEqual(proc.returncode, 5, proc.stderr)
        lines = read_jsonl(record)
        lines[-1]["status"] = "ok"
        record.write_text("".join(json.dumps(l) + "\n" for l in lines))
        replay = run_cli("replay", str(record), cwd=self.dir)
        self.assertEqual(replay.returncode, 4, replay.stderr)
        self.assertIn("E_DIVERGE", replay.stderr)


class TestSpecValidation(DetrandTestCase):
    def test_e_spec_bad_json(self):
        bad = self.dir / "bad.json"
        bad.write_text("{not json")
        proc = run_cli("run", str(bad), cwd=self.dir)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("E_SPEC", proc.stderr)

    def test_e_spec_missing_file(self):
        proc = run_cli("run", str(self.dir / "nope.json"), cwd=self.dir)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("E_SPEC", proc.stderr)

    def test_e_spec_invalid_specs(self):
        invalid = [
            {},
            {"states": [], "initial": "a", "transitions": {}, "ops": {"x": {}}},
            {"states": ["a"], "initial": "b", "transitions": {}, "ops": {"x": {}}},
            {"states": ["a"], "initial": "a",
             "transitions": {"a": ["nope"]}, "ops": {"x": {}}},
            {"states": ["a"], "initial": "a", "transitions": {},
             "ops": {"x": {"to": "zzz"}}},
            {"states": ["a"], "initial": "a", "transitions": {},
             "ops": {"x": {"args": {"n": {"kind": "int", "lo": 5, "hi": 1}}}}},
            {"states": ["a"], "initial": "a", "transitions": {},
             "ops": {"x": {"args": {"n": {"kind": "weird"}}}}},
            {"states": ["a"], "initial": "a", "transitions": {},
             "ops": {"x": {"fork": {"name": "f", "draws": 0}}}},
        ]
        for spec in invalid:
            with self.assertRaises(SpecError, msg=repr(spec)):
                validate(spec)

    def test_valid_spec_accepted(self):
        validate(COUNTER_SPEC)
        validate(FORK_SPEC)
        validate(FAILING_SPEC)


class TestStream(unittest.TestCase):
    def test_stream_matches_random_module(self):
        seed = 1234
        stream = Stream(seed)
        reference = random.Random(seed)
        for _ in range(50):
            self.assertEqual(stream.randint(0, 10**6), reference.randint(0, 10**6))
        self.assertEqual(stream.position, 50)

    def test_fork_derivation_is_position_and_name_dependent(self):
        base = Stream(9)
        forked_at_0 = base.fork("a")
        base.randint(0, 10)
        forked_at_1 = base.fork("a")
        other_name = Stream(9).fork("b")
        self.assertNotEqual(forked_at_0.seed, forked_at_1.seed)
        self.assertNotEqual(forked_at_0.seed, other_name.seed)
        # Same seed, same position, same name -> identical child stream.
        again = Stream(9).fork("a")
        self.assertEqual(forked_at_0.seed, again.seed)
        self.assertEqual(
            [forked_at_0.randrange(2**32) for _ in range(5)],
            [again.randrange(2**32) for _ in range(5)],
        )

    def test_canonical_json_is_sorted(self):
        self.assertEqual(canonical({"b": 1, "a": 2}), '{"a":2,"b":1}')


if __name__ == "__main__":
    unittest.main()
