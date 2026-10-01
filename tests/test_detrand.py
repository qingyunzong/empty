import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from detrand import core  # noqa: E402


def run_cli(*args, hashseed=None, cwd=None):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    if hashseed is not None:
        env["PYTHONHASHSEED"] = str(hashseed)
    return subprocess.run(
        [sys.executable, "-m", "detrand", *args],
        capture_output=True, text=True, cwd=cwd or ROOT, env=env)


COUNTER_SPEC = {
    "initial": {"count": 0, "log": []},
    "ops": [
        {"name": "add", "kind": "int", "min": 1, "max": 9,
         "apply": "state['count'] += arg"},
        {"name": "note", "kind": "choice", "choices": ["alpha", "beta", "gamma"],
         "apply": "state['log'].append(arg)"},
        {"name": "burst", "kind": "fork", "substeps": 3,
         "subops": [
             {"name": "add", "kind": "int", "min": 1, "max": 3,
              "apply": "state['count'] += arg"},
             {"name": "tag", "kind": "choice", "choices": ["x", "y"],
              "apply": "state['log'].append(arg)"},
         ]},
    ],
    "invariants": ["state['count'] >= 0"],
}

FORK_SPEC = {
    "initial": {"count": 0},
    "ops": [
        {"name": "add", "kind": "int", "min": 1, "max": 100,
         "apply": "state['count'] += arg"},
        {"name": "burst", "kind": "fork", "substeps": 2,
         "subops": [
             {"name": "add", "kind": "int", "min": 1, "max": 5,
              "apply": "state['count'] += arg"},
         ]},
    ],
}

FAILING_SPEC = {
    "initial": {"count": 0},
    "ops": [
        {"name": "add", "kind": "int", "min": 1, "max": 5,
         "apply": "state['count'] += arg"},
    ],
    "invariants": ["state['count'] < 20"],
}


def read_jsonl(path):
    return [json.loads(line) for line in
            Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


class TestDeterminism(unittest.TestCase):
    """Acceptance A: same seed+spec -> byte-identical output across processes."""

    def test_two_processes_byte_identical_and_hashseed_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp, "spec.json")
            spec.write_text(json.dumps(COUNTER_SPEC), encoding="utf-8")
            rec1 = Path(tmp, "run1.jsonl")
            rec2 = Path(tmp, "run2.jsonl")
            r1 = run_cli("run", str(spec), "--seed", "7", "--steps", "200",
                         "--record", str(rec1), hashseed=0)
            r2 = run_cli("run", str(spec), "--seed", "7", "--steps", "200",
                         "--record", str(rec2), hashseed=12345)
            self.assertEqual(r1.returncode, 0, r1.stderr)
            self.assertEqual(r2.returncode, 0, r2.stderr)
            self.assertEqual(rec1.read_bytes(), rec2.read_bytes())

    def test_different_seed_differs(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp, "spec.json")
            spec.write_text(json.dumps(COUNTER_SPEC), encoding="utf-8")
            rec1, rec2 = Path(tmp, "a.jsonl"), Path(tmp, "b.jsonl")
            run_cli("run", str(spec), "--seed", "7", "--steps", "50", "--record", str(rec1))
            run_cli("run", str(spec), "--seed", "8", "--steps", "50", "--record", str(rec2))
            self.assertNotEqual(rec1.read_bytes(), rec2.read_bytes())


class TestFork(unittest.TestCase):
    """Acceptance B: fork does not consume the parent random stream."""

    def test_parent_stream_matches_manual_reference(self):
        seed, steps = 7, 200
        engine = core.Engine(FORK_SPEC, seed)
        records = [engine.step(i) for i in range(steps)]

        # Manual reference: replicate the parent stream with a plain
        # random.Random(seed), drawing nothing for fork steps.
        ref_rng = random.Random(seed)
        ref_ops, ref_args = [], []
        for _ in range(steps):
            idx = ref_rng.randrange(2)
            ref_ops.append(FORK_SPEC["ops"][idx]["name"])
            ref_args.append(ref_rng.randint(1, 100) if idx == 0 else None)

        got_ops = [r["op"] for r in records]
        got_args = [r["args"]["value"] if r["op"] == "add" else None for r in records]
        self.assertEqual(got_ops, ref_ops)
        self.assertEqual(got_args, ref_args)
        self.assertIn("burst", got_ops)  # fork actually exercised

    def test_fork_child_seed_derivation(self):
        seed, steps = 11, 100
        engine = core.Engine(FORK_SPEC, seed)
        records = [engine.step(i) for i in range(steps)]
        for rec in records:
            if rec["op"] != "burst":
                continue
            i = rec["index"]
            h = hashlib.sha256()
            h.update(core.FORK_DOMAIN)
            h.update(str(seed).encode("ascii"))
            h.update(b"\x00")
            h.update(str(i).encode("ascii"))
            h.update(b"\x00")
            h.update("burst".encode("utf-8"))
            expected_seed = int.from_bytes(h.digest()[:16], "big")
            self.assertEqual(rec["args"]["seed"], expected_seed)
            # Child stream reproducible from the derived seed alone.
            child = random.Random(expected_seed)
            for sub in rec["args"]["steps"]:
                child.randrange(1)  # subop pick consumes the child stream too
                self.assertEqual(sub["op"], "add")
                self.assertEqual(sub["args"]["value"], child.randint(1, 5))

    def test_fork_same_position_same_child(self):
        e1 = core.Engine(FORK_SPEC, 3)
        e2 = core.Engine(FORK_SPEC, 3)
        r1 = [e1.step(i) for i in range(50)]
        r2 = [e2.step(i) for i in range(50)]
        self.assertEqual(r1, r2)


class TestReplay(unittest.TestCase):
    """Acceptance C: tampering with one line makes replay exit 4."""

    def _make_record(self, tmp, spec=COUNTER_SPEC, seed=7, steps=60):
        spec_path = Path(tmp, "spec.json")
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        rec = Path(tmp, "run.jsonl")
        res = run_cli("run", str(spec_path), "--seed", str(seed),
                      "--steps", str(steps), "--record", str(rec))
        self.assertEqual(res.returncode, 0, res.stderr)
        return rec

    def test_clean_replay_exits_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            rec = self._make_record(tmp)
            res = run_cli("replay", str(rec), "--failure", str(Path(tmp, "failure.json")))
            self.assertEqual(res.returncode, 0, res.stderr)

    def test_tampered_digest_exits_4(self):
        with tempfile.TemporaryDirectory() as tmp:
            rec = self._make_record(tmp)
            lines = rec.read_text(encoding="utf-8").splitlines()
            obj = json.loads(lines[2])
            obj["digest"] = "0" * 64
            lines[2] = json.dumps(obj)
            rec.write_text("\n".join(lines) + "\n", encoding="utf-8")
            res = run_cli("replay", str(rec), "--failure", str(Path(tmp, "failure.json")))
            self.assertEqual(res.returncode, 4, res.stderr)
            self.assertIn("E_DIVERGE", res.stderr)

    def test_tampered_args_exits_4(self):
        with tempfile.TemporaryDirectory() as tmp:
            rec = self._make_record(tmp)
            lines = rec.read_text(encoding="utf-8").splitlines()
            obj = json.loads(lines[1])
            if obj["op"] == "add":
                obj["args"]["value"] += 1
            else:
                obj["op"] = "add" if obj["op"] != "add" else "note"
            lines[1] = json.dumps(obj)
            rec.write_text("\n".join(lines) + "\n", encoding="utf-8")
            res = run_cli("replay", str(rec), "--failure", str(Path(tmp, "failure.json")))
            self.assertEqual(res.returncode, 4, res.stderr)

    def test_malformed_record_exits_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            rec = Path(tmp, "bad.jsonl")
            rec.write_text("not json\n", encoding="utf-8")
            res = run_cli("replay", str(rec))
            self.assertEqual(res.returncode, 3, res.stderr)
            self.assertIn("E_REPLAY", res.stderr)

    def test_missing_record_exits_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = run_cli("replay", str(Path(tmp, "nope.jsonl")))
            self.assertEqual(res.returncode, 3, res.stderr)
            self.assertIn("E_REPLAY", res.stderr)


class TestInvariantFailure(unittest.TestCase):
    """Acceptance D: invariant failure is archived and replay reproduces it."""

    def test_run_archives_failure_and_replay_reproduces(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp, "spec.json")
            spec.write_text(json.dumps(FAILING_SPEC), encoding="utf-8")
            rec = Path(tmp, "run.jsonl")
            failure = Path(tmp, "failure.json")
            res = run_cli("run", str(spec), "--seed", "7", "--steps", "200",
                          "--record", str(rec), "--failure", str(failure))
            self.assertEqual(res.returncode, 4, res.stderr)
            self.assertIn("E_DIVERGE", res.stderr)

            info = json.loads(failure.read_text(encoding="utf-8"))
            self.assertEqual(info["seed"], 7)
            self.assertEqual(info["path"], str(rec))
            self.assertIn("last_digest", info)
            self.assertEqual(info["reason"], "invariant_violation")

            records = read_jsonl(rec)
            self.assertEqual(records[-1]["type"], "failure")
            fail_step = records[-1]["step"]
            self.assertEqual(records[-2]["index"], fail_step)

            # Replay reproduces the same failure and re-archives it.
            failure2 = Path(tmp, "failure2.json")
            res2 = run_cli("replay", str(rec), "--failure", str(failure2))
            self.assertEqual(res2.returncode, 4, res2.stderr)
            self.assertIn("E_DIVERGE", res2.stderr)
            info2 = json.loads(failure2.read_text(encoding="utf-8"))
            self.assertEqual(info2["last_digest"], info["last_digest"])
            self.assertEqual(info2["step"], info["step"])


class TestSpecErrors(unittest.TestCase):
    def test_bad_spec_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp, "spec.json")
            spec.write_text(json.dumps({"initial": {}}), encoding="utf-8")
            res = run_cli("run", str(spec), "--seed", "1", "--steps", "1",
                          "--record", str(Path(tmp, "r.jsonl")))
            self.assertEqual(res.returncode, 2, res.stderr)
            self.assertIn("E_SPEC", res.stderr)

    def test_missing_spec_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = run_cli("run", str(Path(tmp, "nope.json")), "--seed", "1",
                          "--steps", "1", "--record", str(Path(tmp, "r.jsonl")))
            self.assertEqual(res.returncode, 2, res.stderr)
            self.assertIn("E_SPEC", res.stderr)

    def test_nested_fork_rejected(self):
        bad = {"initial": {}, "ops": [
            {"name": "f", "kind": "fork", "substeps": 1, "subops": [
                {"name": "g", "kind": "fork", "substeps": 1, "subops": [
                    {"name": "h", "kind": "int", "min": 1, "max": 2,
                     "apply": "pass"}]}]}]}
        with self.assertRaises(core.SpecError):
            core.validate_spec(bad)


if __name__ == "__main__":
    unittest.main()
