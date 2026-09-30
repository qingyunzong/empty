"""Unittest suite for the quorum commit CLI.

Includes a small-scale reference tally: every vote sequence for N=3 is
enumerated and the CLI state after each vote is checked against an
independent counting function.
"""
import itertools
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent
CLI = REPO / "quorum.py"

EXIT_OK = 0
EXIT_CONFLICT = 4
EXIT_LATE_VOTE = 9
EXIT_CRASH = 70

P1, P2, P3 = "p1", "p2", "p3"


def reference_state(votes, quorum, n):
    """Independent reference tally used to cross-check the CLI."""
    successes = sum(1 for v in votes.values() if v == "SUCCESS")
    failures = sum(1 for v in votes.values() if v == "FAIL")
    if successes >= quorum:
        return "COMPLETED"
    if failures >= n - quorum + 1:
        return "FAILED"
    return "COLLECTING"


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ledger = Path(self.tmp.name) / "ledger.jsonl"

    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, str(CLI), "--ledger", str(self.ledger), *argv],
            capture_output=True, text=True)

    def start(self, participants=(P1, P2, P3), quorum=2):
        result = self.run_cli("start", "--participants", *participants,
                              "--quorum", str(quorum))
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        return result

    def vote(self, participant, vote):
        return self.run_cli("vote", participant, vote)

    def state(self):
        result = self.run_cli("state")
        self.assertEqual(result.returncode, EXIT_OK, result.stderr)
        return json.loads(result.stdout)

    def ledger_bytes(self):
        return self.ledger.read_bytes() if self.ledger.exists() else b""


class TestAcceptance(CliCase):
    def test_second_success_vote_completes(self):
        """Q=2, N=3: the second SUCCESS vote converges immediately."""
        self.start()
        self.assertEqual(self.vote(P1, "SUCCESS").returncode, EXIT_OK)
        self.assertEqual(self.state()["state"], "COLLECTING")
        result = self.vote(P2, "SUCCESS")
        self.assertEqual(result.returncode, EXIT_OK)
        self.assertEqual(json.loads(result.stdout)["state"], "COMPLETED")
        snap = self.state()
        self.assertEqual(snap["state"], "COMPLETED")
        self.assertEqual(snap["successes"], 2)
        # Non-voter p3 is canceled.
        self.assertEqual(snap["cancels"], [P3])
        self.assertEqual(snap["outcomes"][P3], "CANCELED")
        # FINALIZING was persisted before COMPLETED.
        kinds = [json.loads(line)["type"]
                 for line in self.ledger.read_text().splitlines()]
        self.assertLess(kinds.index("finalizing"), kinds.index("completed"))

    def test_two_failure_votes_fail_and_compensate(self):
        """N-Q+1 = 2 FAIL votes make success impossible -> FAILED + compensation."""
        self.start()
        self.vote(P1, "SUCCESS")
        self.vote(P2, "FAIL")
        result = self.vote(P3, "FAIL")
        self.assertEqual(result.returncode, EXIT_OK)
        self.assertEqual(json.loads(result.stdout)["state"], "FAILED")
        snap = self.state()
        self.assertEqual(snap["state"], "FAILED")
        self.assertEqual(snap["failures"], 2)
        # The participant that voted SUCCESS is compensated.
        self.assertEqual(snap["compensations"], [P1])
        self.assertEqual(snap["outcomes"][P1], "COMPENSATED")

    def test_late_vote_after_completion_is_rejected(self):
        """Late votes after the final state: exit code 9, ledger unchanged."""
        self.start()
        self.vote(P1, "SUCCESS")
        self.vote(P2, "SUCCESS")
        before = self.ledger_bytes()
        result = self.vote(P3, "FAIL")
        self.assertEqual(result.returncode, EXIT_LATE_VOTE)
        self.assertEqual(self.ledger_bytes(), before)
        # Also late after FAILED (fresh ledger via --force).
        self.run_cli("start", "--participants", P1, P2, P3, "--quorum", "2", "--force")
        self.vote(P1, "FAIL")
        self.vote(P2, "FAIL")
        before = self.ledger_bytes()
        result = self.vote(P3, "SUCCESS")
        self.assertEqual(result.returncode, EXIT_LATE_VOTE)
        self.assertEqual(self.ledger_bytes(), before)

    def test_duplicate_vote_returns_first_result(self):
        self.start()
        self.vote(P1, "SUCCESS")
        before = self.ledger_bytes()
        result = self.vote(P1, "SUCCESS")
        self.assertEqual(result.returncode, EXIT_OK)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["duplicate"])
        self.assertEqual(payload["first_result"], "SUCCESS")
        self.assertEqual(self.ledger_bytes(), before)  # no new event
        self.assertEqual(self.state()["successes"], 1)

    def test_conflicting_vote_is_rejected(self):
        self.start()
        self.vote(P1, "SUCCESS")
        before = self.ledger_bytes()
        result = self.vote(P1, "FAIL")
        self.assertEqual(result.returncode, EXIT_CONFLICT)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["conflict"])
        self.assertEqual(payload["first_result"], "SUCCESS")
        self.assertEqual(self.ledger_bytes(), before)
        self.assertEqual(self.state()["votes"], {P1: "SUCCESS"})


class TestCrashRecovery(CliCase):
    def test_crash_after_vote_event_then_recover(self):
        """Crash after the deciding vote: recovery converges and keeps exact counts."""
        self.start()
        self.vote(P1, "SUCCESS")
        self.assertEqual(self.run_cli("crash", "--at", "vote").returncode, EXIT_OK)
        result = self.vote(P2, "SUCCESS")
        self.assertEqual(result.returncode, EXIT_CRASH)  # died right after the vote event
        kinds = [json.loads(line)["type"]
                 for line in self.ledger.read_text().splitlines()]
        self.assertNotIn("completed", kinds)  # convergence never happened
        recovered = self.run_cli("recover")
        self.assertEqual(recovered.returncode, EXIT_OK)
        snap = json.loads(recovered.stdout)
        self.assertEqual(snap["state"], "COMPLETED")
        self.assertEqual((snap["successes"], snap["failures"]), (2, 0))
        self.assertEqual(snap["cancels"], [P3])

    def test_crash_after_final_event_then_recover(self):
        """Crash after COMPLETED is persisted but before cancels are written."""
        self.start()
        self.vote(P1, "SUCCESS")
        self.run_cli("crash", "--at", "final")
        result = self.vote(P2, "SUCCESS")
        self.assertEqual(result.returncode, EXIT_CRASH)
        kinds = [json.loads(line)["type"]
                 for line in self.ledger.read_text().splitlines()]
        self.assertIn("completed", kinds)
        self.assertNotIn("cancel", kinds)
        recovered = self.run_cli("recover")
        self.assertEqual(recovered.returncode, EXIT_OK)
        snap = json.loads(recovered.stdout)
        self.assertEqual(snap["state"], "COMPLETED")
        self.assertEqual(snap["cancels"], [P3])
        self.assertEqual((snap["successes"], snap["failures"]), (2, 0))

    def test_crash_after_compensate_event_then_recover(self):
        """Q=3, N=5: crash mid-compensation; recovery finishes the remaining ones."""
        self.run_cli("start", "--participants", "p1", "p2", "p3", "p4", "p5",
                     "--quorum", "3")
        self.vote("p1", "SUCCESS")
        self.vote("p2", "SUCCESS")
        self.vote("p3", "FAIL")
        self.vote("p4", "FAIL")
        self.run_cli("crash", "--at", "compensate")
        result = self.vote("p5", "FAIL")  # 3rd failure -> FAILED, compensation starts
        self.assertEqual(result.returncode, EXIT_CRASH)
        events = [json.loads(line) for line in self.ledger.read_text().splitlines()]
        compensations = [e for e in events if e["type"] == "compensate"]
        self.assertEqual(len(compensations), 1)  # crashed after the first one
        recovered = self.run_cli("recover")
        self.assertEqual(recovered.returncode, EXIT_OK)
        snap = json.loads(recovered.stdout)
        self.assertEqual(snap["state"], "FAILED")
        self.assertEqual((snap["successes"], snap["failures"]), (2, 3))
        self.assertEqual(snap["compensations"], ["p1", "p2"])

    def test_recover_is_idempotent(self):
        self.start()
        self.vote(P1, "SUCCESS")
        self.run_cli("crash", "--at", "vote")
        self.vote(P2, "SUCCESS")
        self.run_cli("recover")
        size_after_first = len(self.ledger_bytes())
        again = self.run_cli("recover")
        self.assertEqual(again.returncode, EXIT_OK)
        self.assertEqual(len(self.ledger_bytes()), size_after_first)


class TestReferenceEnumeration(CliCase):
    def test_all_vote_sequences_match_reference_tally(self):
        """Enumerate every vote sequence for N=3, Q=2 and compare the CLI
        state and counts against an independent reference after each vote."""
        participants = [P1, P2, P3]
        quorum, n = 2, 3
        checked = 0
        for order in itertools.permutations(participants):
            for values in itertools.product(["SUCCESS", "FAIL"], repeat=n):
                sequence = list(zip(order, values))
                self.run_cli("start", "--participants", *participants,
                             "--quorum", str(quorum), "--force")
                votes = {}
                for pid, value in sequence:
                    expected = reference_state(votes, quorum, n)
                    if expected != "COLLECTING":
                        # Final state already sealed: late vote, exit 9.
                        result = self.vote(pid, value)
                        self.assertEqual(result.returncode, EXIT_LATE_VOTE,
                                         f"sequence={sequence}")
                        continue
                    result = self.vote(pid, value)
                    self.assertEqual(result.returncode, EXIT_OK,
                                     f"sequence={sequence} stderr={result.stderr}")
                    votes[pid] = value
                    snap = self.state()
                    expected = reference_state(votes, quorum, n)
                    self.assertEqual(snap["state"], expected,
                                     f"sequence={sequence} votes={votes}")
                    self.assertEqual(snap["successes"],
                                     sum(1 for v in votes.values() if v == "SUCCESS"))
                    self.assertEqual(snap["failures"],
                                     sum(1 for v in votes.values() if v == "FAIL"))
                    checked += 1
        self.assertGreater(checked, 0)
        print(f"\nreference enumeration: {checked} vote steps cross-checked")


if __name__ == "__main__":
    unittest.main(verbosity=2)
