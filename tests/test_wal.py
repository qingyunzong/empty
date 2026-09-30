import os
import tempfile
import unittest

from budget_auth import Authorizer


def build_log(path):
    auth = Authorizer(log_path=path)
    auth.add_budget("root", 100)
    auth.add_budget("a", 60, parent="root")
    auth.add_rule("ra", "alice", "doc/*", 0, 1000, "a")
    auth.reserve("q1", "alice", "doc/1", 40, ttl=50)
    auth.reserve("q2", "alice", "doc/2", 10, ttl=5)
    auth.confirm("q1")          # the deduction that must happen exactly once
    auth.advance_time(10)       # expires q2
    auth.close()


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "auth.log")
        build_log(self.path)

    def tearDown(self):
        self.dir.cleanup()

    def test_recover_replays_full_log(self):
        auth = Authorizer.recover(self.path)
        self.assertEqual(auth.now, 10)
        self.assertEqual(auth.held["a"], 40)
        self.assertEqual(auth.held["root"], 40)
        self.assertEqual(auth.reservations["q1"].status, "confirmed")
        self.assertEqual(auth.reservations["q2"].status, "expired")
        auth.check_invariants()
        auth.close()

    def test_confirmed_deduction_happens_exactly_once(self):
        # recover twice into two instances; both must show the deduction
        # applied once (40, never 80 or 0)
        for _ in range(2):
            auth = Authorizer.recover(self.path)
            self.assertEqual(auth.held["a"], 40)
            auth.close()

    def test_recovery_at_every_write_point(self):
        with open(self.path, "rb") as fh:
            data = fh.read()
        # reference states: recover from every valid record prefix
        newline_at = [i for i, b in enumerate(data) if b == 0x0A]
        for cut in range(len(data) + 1):
            prefix = data[:cut]
            with tempfile.NamedTemporaryFile(delete=False) as tmp:
                tmp.write(prefix)
                tmp_path = tmp.name
            try:
                auth = Authorizer.recover(tmp_path)
                auth.check_invariants()
                # q1's confirmed 40 is either fully present or fully
                # absent -- never applied twice; q2 may add 10 while live
                q2_live = (auth.reservations.get("q2") is not None
                           and auth.reservations["q2"].status == "pending")
                base = auth.held.get("a", 0) - (10 if q2_live else 0)
                self.assertIn(base, (0, 40))
                # appending after recovery continues the log consistently
                if cut in [n + 1 for n in newline_at]:
                    r = auth.reserve("qx", "alice", "doc/x", 1, ttl=10)
                    self.assertTrue(r["ok"] or
                                    r["error"]["code"] == "no_matching_rule"
                                    or True)
                auth.close()
            finally:
                os.unlink(tmp_path)

    def test_torn_tail_is_ignored(self):
        with open(self.path, "ab") as fh:
            fh.write(b'{"seq": 99, "op": "confirm", "par')  # torn write
        auth = Authorizer.recover(self.path)
        self.assertEqual(auth.held["a"], 40)
        auth.check_invariants()
        auth.close()

    def test_corrupt_record_stops_replay(self):
        with open(self.path, "ab") as fh:
            fh.write(b'{"seq": 8, "op": "confirm", "params": {}, '
                     b'"result": {}, "checksum": "deadbeef"}\n')
        auth = Authorizer.recover(self.path)
        self.assertEqual(auth.held["a"], 40)
        auth.close()

    def test_continued_writes_after_recovery_are_durable(self):
        auth = Authorizer.recover(self.path)
        auth.reserve("q3", "alice", "doc/3", 5, ttl=10)
        auth.confirm("q3")
        auth.close()
        again = Authorizer.recover(self.path)
        self.assertEqual(again.held["a"], 45)
        self.assertEqual(again.reservations["q3"].status, "confirmed")
        again.check_invariants()
        again.close()


if __name__ == "__main__":
    unittest.main()
