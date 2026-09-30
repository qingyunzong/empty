"""Unittest suite for the idempotent inbox CLI (idem.py).

Includes a model-based test: a reference mapping enumerates each idemkey to
its expected final state and expected side effects, and the real CLI output
is checked against that model.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = [sys.executable, str(ROOT / "idem.py")]

EXIT_OK = 0
EXIT_PROCESSING_DUPLICATE = 2
EXIT_INVALID_INPUT = 4
EXIT_PERMANENT_FAILURE = 10


def task_json(idemkey, payload):
    return json.dumps({"idemkey": idemkey, "payload": payload})


class CliCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = Path(self._tmp.name) / "store"

    def run_cli(self, *args):
        return subprocess.run(
            CLI + ["--store", str(self.store), *args],
            capture_output=True, text=True,
        )

    def out_json(self, proc):
        return json.loads(proc.stdout)

    def enqueue(self, idemkey, payload):
        return self.run_cli("enqueue", task_json(idemkey, payload))

    def get(self, idemkey):
        proc = self.run_cli("get", "--idemkey", idemkey)
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        return self.out_json(proc)

    def compute_log(self):
        path = self.store / "compute_log.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()]

    def load_store_json(self, name):
        path = self.store / name
        if not path.exists():
            return {}
        return json.loads(path.read_text())


class TestEnqueue(CliCase):
    def test_first_enqueue_accepts_and_persists(self):
        proc = self.enqueue("k1", "hello")
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        out = self.out_json(proc)
        self.assertTrue(out["accepted"])
        self.assertEqual(out["task"]["status"], "RECEIVED")
        self.assertEqual(out["task"]["attempts"], 0)
        inbox = self.load_store_json("inbox.json")
        self.assertEqual(list(inbox), ["k1"])

    def test_duplicate_enqueue_returns_original_without_new_record(self):
        first = self.out_json(self.enqueue("k1", "hello"))
        second_proc = self.enqueue("k1", "hello")
        self.assertEqual(second_proc.returncode, EXIT_OK, second_proc.stderr)
        second = self.out_json(second_proc)
        self.assertFalse(second["accepted"])
        self.assertEqual(second["task"], first["task"])
        inbox = self.load_store_json("inbox.json")
        self.assertEqual(len(inbox), 1)

    def test_missing_fields_are_invalid(self):
        for bad in ("{}", '{"idemkey": "k1"}', '{"payload": "x"}',
                    "not json", '[]', '{"idemkey": "", "payload": "x"}'):
            proc = self.run_cli("enqueue", bad)
            self.assertEqual(proc.returncode, EXIT_INVALID_INPUT, bad)
            self.assertIn("error", proc.stderr)


class TestRunOnce(CliCase):
    def test_run_once_success_then_no_reexecution(self):
        self.enqueue("k1", "hello")
        proc = self.run_cli("run-once")
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        self.assertEqual(self.out_json(proc)["status"], "SUCCEEDED")
        got = self.get("k1")
        self.assertEqual(got["status"], "SUCCEEDED")
        self.assertEqual(got["attempts"], 1)
        self.assertEqual(got["result"], "effect[k1]=hello")
        # Duplicate run-once: no re-execution, still exactly one computation.
        again = self.run_cli("run-once", "--idemkey", "k1")
        self.assertEqual(again.returncode, EXIT_OK, again.stderr)
        self.assertEqual(self.out_json(again)["status"], "SUCCEEDED")
        self.assertEqual(self.get("k1")["attempts"], 1)
        self.assertEqual(len(self.compute_log()), 1)
        # Result persisted in the result file.
        self.assertEqual(self.load_store_json("results.json"),
                         {"k1": "effect[k1]=hello"})

    def test_run_once_with_empty_inbox_is_noop(self):
        proc = self.run_cli("run-once")
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        self.assertEqual(self.out_json(proc)["message"], "no pending tasks")

    def test_run_once_unknown_key_invalid(self):
        proc = self.run_cli("run-once", "--idemkey", "nope")
        self.assertEqual(proc.returncode, EXIT_INVALID_INPUT)

    def test_bad_payload_fails_permanently_without_infinite_retry(self):
        self.enqueue("bad1", "BAD")
        proc = self.run_cli("run-once")
        self.assertEqual(proc.returncode, EXIT_PERMANENT_FAILURE, proc.stderr)
        got = self.get("bad1")
        self.assertEqual(got["status"], "FAILED")
        self.assertEqual(got["attempts"], 1)
        self.assertIsNotNone(got["error"])
        # Terminal: further run-once does not retry the FAILED task.
        again = self.run_cli("run-once")
        self.assertEqual(again.returncode, EXIT_OK, again.stderr)
        self.assertEqual(self.out_json(again)["message"], "no pending tasks")
        self.assertEqual(self.get("bad1")["attempts"], 1)
        # recover does not resurrect FAILED tasks either.
        rec = self.run_cli("recover")
        self.assertEqual(rec.returncode, EXIT_OK, rec.stderr)
        self.assertEqual(self.out_json(rec)["recovered"], [])
        self.assertEqual(self.get("bad1")["attempts"], 1)


class TestCrashRecover(CliCase):
    def test_crash_after_claim_then_recover_same_result(self):
        self.enqueue("k1", "hello")
        crash = self.run_cli("crash", "--after", "CLAIM", "--idemkey", "k1")
        self.assertEqual(crash.returncode, EXIT_OK, crash.stderr)
        got = self.get("k1")
        self.assertEqual(got["status"], "PROCESSING")
        self.assertEqual(got["attempts"], 1)
        # CLAIM event was persisted before the 'crash'.
        events = (self.store / "events.jsonl").read_text()
        self.assertIn('"CLAIM"', events)
        # A duplicate run while PROCESSING is rejected with exit code 2.
        dup = self.run_cli("run-once", "--idemkey", "k1")
        self.assertEqual(dup.returncode, EXIT_PROCESSING_DUPLICATE, dup.stderr)
        # recover re-runs with the same idemkey and reaches the same result.
        rec = self.run_cli("recover")
        self.assertEqual(rec.returncode, EXIT_OK, rec.stderr)
        got = self.get("k1")
        self.assertEqual(got["status"], "SUCCEEDED")
        self.assertEqual(got["result"], "effect[k1]=hello")
        self.assertEqual(got["attempts"], 2)
        # Idempotent processor: the side effect was computed exactly once.
        self.assertEqual(len(self.compute_log()), 1)
        self.assertEqual(self.load_store_json("effects.json"),
                         {"k1": "effect[k1]=hello"})

    def test_recover_with_nothing_crashed_is_noop(self):
        proc = self.run_cli("recover")
        self.assertEqual(proc.returncode, EXIT_OK, proc.stderr)
        self.assertEqual(self.out_json(proc)["recovered"], [])

    def test_recover_bad_payload_fails_permanently(self):
        self.enqueue("bad1", "BAD")
        self.run_cli("crash", "--after", "CLAIM", "--idemkey", "bad1")
        rec = self.run_cli("recover")
        self.assertEqual(rec.returncode, EXIT_PERMANENT_FAILURE, rec.stderr)
        got = self.get("bad1")
        self.assertEqual(got["status"], "FAILED")
        # No infinite retry: a second recover finds nothing to do.
        rec2 = self.run_cli("recover")
        self.assertEqual(rec2.returncode, EXIT_OK, rec2.stderr)
        self.assertEqual(self.get("bad1")["attempts"], 2)


class TestGetAndCorruption(CliCase):
    def test_get_reports_status_result_attempts(self):
        self.enqueue("k1", "hello")
        got = self.get("k1")
        self.assertEqual(
            got, {"idemkey": "k1", "status": "RECEIVED", "attempts": 0,
                  "result": None, "error": None})
        self.run_cli("run-once")
        got = self.get("k1")
        self.assertEqual(got["status"], "SUCCEEDED")
        self.assertEqual(got["result"], "effect[k1]=hello")
        self.assertEqual(got["attempts"], 1)

    def test_get_unknown_key_invalid(self):
        proc = self.run_cli("get", "--idemkey", "nope")
        self.assertEqual(proc.returncode, EXIT_INVALID_INPUT)
        self.assertIn("unknown idemkey", proc.stderr)

    def test_corrupted_result_file_reports_clear_error(self):
        self.enqueue("k1", "hello")
        self.run_cli("run-once")
        (self.store / "results.json").write_text("{not valid json!!!")
        proc = self.run_cli("get", "--idemkey", "k1")
        self.assertEqual(proc.returncode, EXIT_INVALID_INPUT)
        self.assertIn("corrupted", proc.stderr)
        self.assertIn("results.json", proc.stderr)

    def test_corrupted_inbox_reports_clear_error(self):
        self.enqueue("k1", "hello")
        (self.store / "inbox.json").write_text("###broken###")
        proc = self.run_cli("get", "--idemkey", "k1")
        self.assertEqual(proc.returncode, EXIT_INVALID_INPUT)
        self.assertIn("corrupted", proc.stderr)


class TestReferenceModel(CliCase):
    """Model-based test: a reference mapping enumerates every idemkey to its
    expected final state and side effects; the real CLI is driven through a
    scenario and checked against the model."""

    def test_scenario_against_reference_model(self):
        # Reference model: idemkey -> expected final state and side effects.
        model = {
            "alpha": {"status": "SUCCEEDED", "attempts": 1,
                      "result": "effect[alpha]=p-alpha",
                      "computes": 1, "effects": 1},
            "beta": {"status": "SUCCEEDED", "attempts": 2,  # crash + recover
                     "result": "effect[beta]=p-beta",
                     "computes": 1, "effects": 1},
            "gamma": {"status": "FAILED", "attempts": 1,    # BAD payload
                      "result": None,
                      "computes": 0, "effects": 0},
            "delta": {"status": "RECEIVED", "attempts": 0,  # never processed
                      "result": None,
                      "computes": 0, "effects": 0},
        }

        # Enqueue all keys; duplicate enqueues must not create new records.
        self.enqueue("alpha", "p-alpha")
        self.enqueue("beta", "p-beta")
        self.enqueue("gamma", "BAD")
        self.enqueue("delta", "p-delta")
        for key in model:
            dup = self.enqueue(key, "whatever")
            self.assertEqual(dup.returncode, EXIT_OK)
            self.assertFalse(self.out_json(dup)["accepted"])
        self.assertEqual(len(self.load_store_json("inbox.json")), len(model))

        # Drive the scenario: run alpha, crash beta after CLAIM, run gamma.
        self.run_cli("run-once", "--idemkey", "alpha")
        self.run_cli("crash", "--after", "CLAIM", "--idemkey", "beta")
        self.run_cli("run-once", "--idemkey", "gamma")
        # Duplicate run of alpha while PROCESSING is not possible (already
        # SUCCEEDED), but beta is PROCESSING: duplicate run -> exit 2.
        self.assertEqual(
            self.run_cli("run-once", "--idemkey", "beta").returncode,
            EXIT_PROCESSING_DUPLICATE)
        # Recover re-runs crashed tasks with the same idemkey.
        self.assertEqual(self.run_cli("recover").returncode, EXIT_OK)

        # Check final state of every key against the reference model.
        for key, expected in model.items():
            got = self.get(key)
            self.assertEqual(got["status"], expected["status"], key)
            self.assertEqual(got["attempts"], expected["attempts"], key)
            self.assertEqual(got["result"], expected["result"], key)

        # Check side effects against the reference model.
        computes = self.compute_log()
        effects = self.load_store_json("effects.json")
        for key, expected in model.items():
            key_computes = [c for c in computes if c["idemkey"] == key]
            self.assertEqual(len(key_computes), expected["computes"], key)
            self.assertEqual(1 if key in effects else 0,
                             expected["effects"], key)
        self.assertEqual(len(computes),
                         sum(m["computes"] for m in model.values()))
        self.assertEqual(len(effects),
                         sum(m["effects"] for m in model.values()))

        # Result file holds exactly the succeeded results.
        results = self.load_store_json("results.json")
        self.assertEqual(
            results,
            {k: m["result"] for k, m in model.items()
             if m["status"] == "SUCCEEDED"})


if __name__ == "__main__":
    unittest.main()
