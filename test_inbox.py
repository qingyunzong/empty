"""End-to-end tests for the idempotent inbox CLI.

Each test drives the real CLI via subprocess and checks the persisted
state against a reference mapping that enumerates, per idemkey, the
expected state and the expected side effects.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "inbox.py")

EXIT_OK = 0
EXIT_PROCESSING_DUPLICATE = 2
EXIT_STORAGE_CORRUPT = 3
EXIT_INVALID_INPUT = 4
EXIT_PERMANENT_FAILURE = 10


class InboxCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name
        # Reference mapping: idemkey -> {"state": ..., "effects": [...]}
        self.model = {}

    # -- helpers ------------------------------------------------------------

    def cli(self, *args):
        env = dict(os.environ, INBOX_DIR=self.dir)
        return subprocess.run(
            [sys.executable, CLI, *args],
            capture_output=True,
            text=True,
            env=env,
        )

    def enqueue(self, idemkey, payload):
        return self.cli("enqueue", json.dumps({"idemkey": idemkey, "payload": payload}))

    def load_json(self, name):
        path = os.path.join(self.dir, name)
        if not os.path.exists(path):
            return {}
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def results(self):
        return self.load_json("results.json")

    def effects(self):
        return self.load_json("effects.json")

    def journal_events(self):
        path = os.path.join(self.dir, "journal.log")
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def assert_model(self):
        """Persisted state and side effects must match the reference mapping."""
        results = self.results()
        self.assertEqual(set(results), set(self.model))
        for key, expected in self.model.items():
            self.assertEqual(results[key]["status"], expected["state"], key)
        actual_effects = self.effects()
        expected_effects = {
            k: v for k, v in ((k, f"applied:{results[k]['payload']}")
                              for k in self.model
                              if self.model[k]["effects"])
        }
        self.assertEqual(actual_effects, expected_effects)

    # -- tests ---------------------------------------------------------------

    def test_enqueue_accepts_once_and_dedupes(self):
        first = self.enqueue("k1", "alpha")
        self.assertEqual(first.returncode, EXIT_OK, first.stderr)
        accepted = json.loads(first.stdout)
        self.assertEqual(accepted["note"], "accepted")
        self.model["k1"] = {"state": "RECEIVED", "effects": []}
        self.assert_model()

        dup = self.enqueue("k1", "alpha")
        self.assertEqual(dup.returncode, EXIT_OK, dup.stderr)
        duplicate = json.loads(dup.stdout)
        self.assertEqual(duplicate["note"], "duplicate")
        self.assertEqual(duplicate["task"], accepted["task"])
        # No new task record and no extra ENQUEUE event.
        self.assertEqual(len(self.results()), 1)
        enqueues = [e for e in self.journal_events() if e["event"] == "ENQUEUE"]
        self.assertEqual(len(enqueues), 1)
        self.assert_model()

    def test_run_once_succeeds_and_is_idempotent(self):
        self.enqueue("k1", "alpha")
        run = self.cli("run-once", "k1")
        self.assertEqual(run.returncode, EXIT_OK, run.stderr)
        record = json.loads(run.stdout)["task"]
        self.assertEqual(record["status"], "SUCCEEDED")
        self.assertEqual(record["attempts"], 1)
        self.model["k1"] = {"state": "SUCCEEDED", "effects": ["applied:alpha"]}
        self.assert_model()

        # Repeated runs must not re-execute the side effect.
        again = self.cli("run-once", "k1")
        self.assertEqual(again.returncode, EXIT_OK, again.stderr)
        self.assertEqual(json.loads(again.stdout)["note"], "already succeeded")
        self.assertEqual(self.results()["k1"]["attempts"], 1)
        # Repeated enqueue after success still returns the same record.
        dup = self.enqueue("k1", "alpha")
        self.assertEqual(json.loads(dup.stdout)["task"]["status"], "SUCCEEDED")
        self.assertEqual(len(self.results()), 1)
        claims = [e for e in self.journal_events() if e["event"] == "CLAIM"]
        self.assertEqual(len(claims), 1)
        self.assert_model()

    def test_crash_after_claim_then_recover_same_result(self):
        self.enqueue("k1", "alpha")
        crash = self.cli("crash", "--after", "CLAIM", "k1")
        self.assertEqual(crash.returncode, 1)
        self.assertIn("simulated crash", crash.stderr)
        # CLAIM was persisted before the crash.
        self.assertEqual(self.results()["k1"]["status"], "PROCESSING")
        self.assertEqual(self.results()["k1"]["attempts"], 1)
        self.assertEqual(self.effects(), {})  # no side effect yet

        # A concurrent run while PROCESSING is rejected.
        busy = self.cli("run-once", "k1")
        self.assertEqual(busy.returncode, EXIT_PROCESSING_DUPLICATE)

        recover = self.cli("recover")
        self.assertEqual(recover.returncode, EXIT_OK, recover.stderr)
        recovered = json.loads(recover.stdout)["task"]
        self.assertEqual(recovered["status"], "SUCCEEDED")
        self.assertEqual(recovered["result"],
                         {"payload": "alpha", "effect": "applied:alpha"})
        self.model["k1"] = {"state": "SUCCEEDED", "effects": ["applied:alpha"]}
        self.assert_model()

        # Idempotent re-run after recovery: still one effect, no re-execution.
        again = self.cli("run-once", "k1")
        self.assertEqual(again.returncode, EXIT_OK)
        self.assertEqual(self.effects(), {"k1": "applied:alpha"})
        self.assert_model()

    def test_recovered_result_matches_clean_run_result(self):
        # Clean run in a second inbox produces the same result as recovery.
        self.enqueue("k1", "alpha")
        self.cli("crash", "--after", "CLAIM", "k1")
        self.cli("recover")
        recovered = self.results()["k1"]["result"]

        with tempfile.TemporaryDirectory() as clean_dir:
            env = dict(os.environ, INBOX_DIR=clean_dir)
            subprocess.run(
                [sys.executable, CLI, "enqueue",
                 json.dumps({"idemkey": "k1", "payload": "alpha"})],
                capture_output=True, text=True, env=env, check=True)
            subprocess.run([sys.executable, CLI, "run-once", "k1"],
                           capture_output=True, text=True, env=env, check=True)
            with open(os.path.join(clean_dir, "results.json"),
                      encoding="utf-8") as fh:
                clean = json.load(fh)["k1"]["result"]
        self.assertEqual(recovered, clean)

    def test_bad_payload_fails_permanently(self):
        self.enqueue("bad-1", "BAD")
        run = self.cli("run-once", "bad-1")
        self.assertEqual(run.returncode, EXIT_PERMANENT_FAILURE)
        self.assertEqual(self.results()["bad-1"]["status"], "FAILED")
        self.assertEqual(self.results()["bad-1"]["attempts"], 1)
        self.model["bad-1"] = {"state": "FAILED", "effects": []}
        self.assert_model()

        # No infinite retry: re-running keeps FAILED, attempts unchanged.
        retry = self.cli("run-once", "bad-1")
        self.assertEqual(retry.returncode, EXIT_PERMANENT_FAILURE)
        self.assertEqual(self.results()["bad-1"]["attempts"], 1)
        # recover must not resurrect a permanently failed task.
        recover = self.cli("recover")
        self.assertEqual(recover.returncode, EXIT_OK)
        self.assertEqual(self.results()["bad-1"]["status"], "FAILED")
        self.assert_model()

    def test_get_reports_status_result_attempts(self):
        self.enqueue("k1", "alpha")
        self.cli("run-once", "k1")
        got = self.cli("get", "k1")
        self.assertEqual(got.returncode, EXIT_OK, got.stderr)
        record = json.loads(got.stdout)
        self.assertEqual(record["status"], "SUCCEEDED")
        self.assertEqual(record["result"],
                         {"payload": "alpha", "effect": "applied:alpha"})
        self.assertEqual(record["attempts"], 1)

        missing = self.cli("get", "nope")
        self.assertEqual(missing.returncode, EXIT_INVALID_INPUT)
        self.assertIn("unknown idemkey", missing.stderr)

    def test_missing_fields_are_rejected(self):
        for task in ('{"payload": "x"}', '{"idemkey": "k1"}',
                     'not json', '[1, 2]', '{"idemkey": "", "payload": 1}'):
            res = self.cli("enqueue", task)
            self.assertEqual(res.returncode, EXIT_INVALID_INPUT, task)
            self.assertIn("error", res.stderr)
        self.assertEqual(self.results(), {})

    def test_corrupt_results_file_reports_clear_error(self):
        self.enqueue("k1", "alpha")
        with open(os.path.join(self.dir, "results.json"), "w",
                  encoding="utf-8") as fh:
            fh.write("{ not valid json !!!")
        for args in (("get", "k1"), ("run-once", "k1"), ("recover",),
                     ("enqueue", '{"idemkey": "k2", "payload": "b"}')):
            res = self.cli(*args)
            self.assertEqual(res.returncode, EXIT_STORAGE_CORRUPT, args)
            self.assertIn("corrupt", res.stderr)

    def test_multiple_keys_reference_mapping(self):
        # Enumerate several keys through full lifecycles in one inbox.
        plan = {
            "k-ok": {"payload": "alpha", "state": "SUCCEEDED",
                     "effects": ["applied:alpha"]},
            "k-bad": {"payload": "BAD", "state": "FAILED", "effects": []},
            "k-crash": {"payload": "gamma", "state": "SUCCEEDED",
                        "effects": ["applied:gamma"]},
            "k-pending": {"payload": "delta", "state": "RECEIVED",
                          "effects": []},
        }
        for key, spec in plan.items():
            self.assertEqual(self.enqueue(key, spec["payload"]).returncode,
                             EXIT_OK)
        self.assertEqual(self.cli("run-once", "k-ok").returncode, EXIT_OK)
        self.assertEqual(self.cli("run-once", "k-bad").returncode,
                         EXIT_PERMANENT_FAILURE)
        self.assertEqual(
            self.cli("crash", "--after", "CLAIM", "k-crash").returncode, 1)
        self.assertEqual(self.cli("recover").returncode, EXIT_OK)

        self.model = {k: {"state": v["state"], "effects": v["effects"]}
                      for k, v in plan.items()}
        self.assert_model()
        # Side effects executed exactly once per successful key.
        self.assertEqual(self.effects(),
                         {"k-ok": "applied:alpha",
                          "k-crash": "applied:gamma"})


if __name__ == "__main__":
    unittest.main()
