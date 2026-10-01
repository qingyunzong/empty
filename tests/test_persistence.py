import json
import os
import tempfile
import unittest

from budget_auth.system import Authorizer

# Every op here is accepted and writes exactly one log record (time only
# advances via explicit tick ops), so log line k corresponds to op k.
OPS = [
    {"op": "add_budget", "id": "p", "quota": 100},
    {"op": "add_budget", "id": "a", "quota": 60, "parent": "p"},
    {"op": "add_budget", "id": "b", "quota": 60, "parent": "p"},
    {"op": "add_rule", "id": "ra", "subject": "*", "resource": "*",
     "budget": "a", "start": 0, "end": 100},
    {"op": "add_rule", "id": "rb", "subject": "*", "resource": "*",
     "budget": "b", "start": 0, "end": 100},
    {"op": "reserve", "request": "q1", "subject": "alice",
     "resource": "gpu", "amount": 30, "ttl": 10},
    {"op": "reserve", "request": "q2", "subject": "bob",
     "resource": "gpu", "amount": 40, "ttl": 3},
    {"op": "confirm", "request": "q1"},
    {"op": "tick", "now": 5},                      # q2 expires here
    {"op": "reserve", "request": "q3", "subject": "alice",
     "resource": "gpu", "amount": 50, "ttl": 10},
    {"op": "set_quota", "budget": "b", "quota": 45},
    {"op": "release", "request": "q3"},
    {"op": "reserve", "request": "q4", "subject": "bob",
     "resource": "gpu", "amount": 20, "ttl": 10},
    {"op": "confirm", "request": "q4"},
    {"op": "tick", "now": 20},
]


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.dir.name, "state.log")

    def tearDown(self):
        self.dir.cleanup()

    def _run(self):
        auth = Authorizer(log_path=self.log)
        snapshots = []
        for op in OPS:
            result = auth.apply(op)
            self.assertTrue(result["ok"], f"{op}: {result}")
            snapshots.append(auth.snapshot())
        auth.close()
        return snapshots

    def test_recover_at_every_write_point(self):
        snapshots = self._run()
        with open(self.log, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        self.assertEqual(len(lines), len(OPS))
        for k in range(len(lines) + 1):
            prefix = os.path.join(self.dir.name, f"prefix{k}.log")
            with open(prefix, "w", encoding="utf-8") as fh:
                fh.write("".join(line + "\n" for line in lines[:k]))
            recovered = Authorizer.recover(prefix)
            expected = snapshots[k - 1] if k else Authorizer().snapshot()
            self.assertEqual(recovered.snapshot(), expected,
                             f"recovery diverged at write point {k}")
            recovered.close()

    def test_confirmed_deduction_happens_once_after_replay(self):
        self._run()
        recovered = Authorizer.recover(self.log)
        # q1 confirmed 30 and q4 confirmed 20, both on budget a;
        # replay must count each exactly once
        self.assertEqual(recovered._used()["a"], 50)
        self.assertEqual(recovered._used()["b"], 0)
        self.assertEqual(recovered._used()["p"], 50)
        recovered.close()

    def test_replay_is_idempotent_for_duplicate_confirm_record(self):
        self._run()
        # simulate a duplicated confirm record (e.g. retried write)
        confirm_q1 = json.dumps({"op": "confirm", "request": "q1"},
                                sort_keys=True)
        with open(self.log, "a", encoding="utf-8") as fh:
            fh.write(confirm_q1 + "\n")
        recovered = Authorizer.recover(self.log)
        self.assertEqual(recovered._used()["a"], 50)
        self.assertEqual(recovered.reservations["q1"].status, "confirmed")
        recovered.close()

    def test_recovery_replay_after_crash_mid_scenario(self):
        # run half the ops, "crash", recover, continue, compare with a
        # from-scratch run of the whole script
        half = len(OPS) // 2
        auth = Authorizer(log_path=self.log)
        for op in OPS[:half]:
            auth.apply(op)
        auth.close()
        recovered = Authorizer.recover(self.log)
        for op in OPS[half:]:
            recovered.apply(op)
        fresh = Authorizer()
        for op in OPS:
            fresh.apply(op)
        self.assertEqual(recovered.snapshot(), fresh.snapshot())
        recovered.close()

    def test_rejected_ops_are_not_logged(self):
        auth = Authorizer(log_path=self.log)
        auth.apply({"op": "add_budget", "id": "p", "quota": 10})
        auth.apply({"op": "add_rule", "id": "r", "subject": "*",
                    "resource": "*", "budget": "p", "start": 0, "end": 5})
        rejected = auth.apply({"op": "reserve", "request": "q1",
                               "subject": "a", "resource": "b",
                               "amount": 99, "ttl": 1})
        self.assertFalse(rejected["ok"])
        auth.close()
        with open(self.log, encoding="utf-8") as fh:
            self.assertEqual(len(fh.read().splitlines()), 2)
        recovered = Authorizer.recover(self.log)
        self.assertEqual(recovered.reservations, {})
        recovered.close()


if __name__ == "__main__":
    unittest.main()
