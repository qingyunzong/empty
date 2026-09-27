#!/usr/bin/env python3
"""Unittests for consensus.py, including a reference-tally enumeration check."""

from __future__ import annotations

import itertools
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import consensus  # noqa: E402

CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "consensus.py")


def reference_status(votes: dict, n: int, q: int) -> str:
    """Independent reference tally used to cross-check the implementation."""
    success = sum(1 for r in votes.values() if r == "SUCCESS")
    fail = sum(1 for r in votes.values() if r == "FAIL")
    if success >= q:
        return "COMPLETED"
    if fail >= n - q + 1:
        return "FAILED"
    return "COLLECTING"


class CliTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = os.path.join(self.tmp.name, "consensus.log")

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, CLI, *args, "--log", self.log],
            capture_output=True,
            text=True,
        )

    def start(self, participants=("p1", "p2", "p3"), quorum=2) -> None:
        proc = self.run_cli("start", "--participants", *participants, "--quorum", str(quorum))
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def vote(self, pid: str, result: str) -> subprocess.CompletedProcess:
        return self.run_cli("vote", pid, result)

    def state(self) -> dict:
        proc = self.run_cli("state")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def log_events(self) -> list[dict]:
        with open(self.log, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def log_bytes(self) -> bytes:
        with open(self.log, "rb") as fh:
            return fh.read()


class TestQuorumCompletion(CliTestCase):
    def test_second_success_vote_completes(self) -> None:
        # Acceptance: Q=2, N=3 -> the 2nd SUCCESS vote completes the round.
        self.start()
        proc = self.vote("p1", "SUCCESS")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.state()["status"], "COLLECTING")

        proc = self.vote("p2", "SUCCESS")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        st = self.state()
        self.assertEqual(st["status"], "COMPLETED")
        self.assertEqual(st["success_count"], 2)
        self.assertEqual(st["canceled"], ["p3"])  # non-voter canceled

        # FINALIZING is persisted before COMPLETED.
        kinds = [ev["type"] for ev in self.log_events()]
        self.assertEqual(kinds, ["start", "vote", "vote", "finalizing", "cancel", "completed"])


class TestFailureAndCompensation(CliTestCase):
    def test_two_fail_votes_fail_and_compensate(self) -> None:
        # Acceptance: N-Q+1 = 2 FAIL votes -> FAILED, SUCCESS voter compensated.
        self.start()
        self.assertEqual(self.vote("p1", "SUCCESS").returncode, 0)
        self.assertEqual(self.vote("p2", "FAIL").returncode, 0)
        self.assertEqual(self.state()["status"], "COLLECTING")

        self.assertEqual(self.vote("p3", "FAIL").returncode, 0)
        st = self.state()
        self.assertEqual(st["status"], "FAILED")
        self.assertEqual(st["fail_count"], 2)
        self.assertEqual(st["compensated"], ["p1"])

        kinds = [ev["type"] for ev in self.log_events()]
        self.assertEqual(
            kinds,
            ["start", "vote", "vote", "vote", "compensate", "failed"],
        )


class TestLateVote(CliTestCase):
    def test_late_vote_exit_9_and_ledger_unchanged(self) -> None:
        self.start()
        self.vote("p1", "SUCCESS")
        self.vote("p2", "SUCCESS")
        self.assertEqual(self.state()["status"], "COMPLETED")

        before = self.log_bytes()
        proc = self.vote("p3", "SUCCESS")
        self.assertEqual(proc.returncode, 9, proc.stderr)
        self.assertEqual(self.log_bytes(), before)  # ledger untouched

    def test_late_vote_after_failure_exit_9(self) -> None:
        self.start()
        self.vote("p1", "FAIL")
        self.vote("p2", "FAIL")
        self.assertEqual(self.state()["status"], "FAILED")
        before = self.log_bytes()
        proc = self.vote("p3", "SUCCESS")
        self.assertEqual(proc.returncode, 9, proc.stderr)
        self.assertEqual(self.log_bytes(), before)


class TestDuplicateAndConflict(CliTestCase):
    def test_duplicate_vote_returns_first_result(self) -> None:
        self.start()
        self.assertEqual(self.vote("p1", "SUCCESS").returncode, 0)
        events_before = len(self.log_events())
        proc = self.vote("p1", "SUCCESS")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("duplicate", proc.stdout)
        self.assertIn("SUCCESS", proc.stdout)  # first result reported
        self.assertEqual(len(self.log_events()), events_before)  # idempotent
        self.assertEqual(self.state()["success_count"], 1)

    def test_conflicting_vote_rejected(self) -> None:
        self.start()
        self.assertEqual(self.vote("p1", "SUCCESS").returncode, 0)
        before = self.log_bytes()
        proc = self.vote("p1", "FAIL")
        self.assertEqual(proc.returncode, 4, proc.stderr)
        self.assertIn("conflict", proc.stderr.lower())
        self.assertEqual(self.log_bytes(), before)
        self.assertEqual(self.state()["votes"], {"p1": "SUCCESS"})


class TestCrashRecovery(CliTestCase):
    def test_crash_after_vote_event_then_recover(self) -> None:
        self.start()
        self.vote("p1", "SUCCESS")
        self.assertEqual(self.run_cli("crash", "--at", "VOTE").returncode, 0)
        proc = self.vote("p2", "SUCCESS")  # quorum reached, but crash first
        self.assertEqual(proc.returncode, 3)

        st = self.state()  # vote persisted, finalization never ran
        self.assertEqual(st["status"], "COLLECTING")
        self.assertEqual(st["success_count"], 2)

        proc = self.run_cli("recover")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        st = self.state()
        self.assertEqual(st["status"], "COMPLETED")
        self.assertEqual(st["votes"], {"p1": "SUCCESS", "p2": "SUCCESS"})
        self.assertEqual(st["success_count"], 2)  # exact tally rebuilt from log
        self.assertEqual(st["canceled"], ["p3"])

    def test_crash_after_final_event_then_recover(self) -> None:
        self.start()
        self.vote("p1", "SUCCESS")
        self.assertEqual(self.run_cli("crash", "--at", "FINAL").returncode, 0)
        proc = self.vote("p2", "SUCCESS")
        self.assertEqual(proc.returncode, 3)

        st = self.state()  # FINALIZING persisted, COMPLETED not yet
        self.assertEqual(st["status"], "FINALIZING")

        # Late vote while FINALIZING is rejected with exit 9.
        proc = self.vote("p3", "FAIL")
        self.assertEqual(proc.returncode, 9, proc.stderr)

        self.assertEqual(self.run_cli("recover").returncode, 0)
        st = self.state()
        self.assertEqual(st["status"], "COMPLETED")
        self.assertEqual(st["success_count"], 2)
        self.assertEqual(st["canceled"], ["p3"])

    def test_crash_after_compensate_event_then_recover(self) -> None:
        self.start()
        self.vote("p1", "SUCCESS")
        self.vote("p2", "FAIL")
        self.assertEqual(self.run_cli("crash", "--at", "COMPENSATE").returncode, 0)
        proc = self.vote("p3", "FAIL")  # failure threshold met, crash mid-compensation
        self.assertEqual(proc.returncode, 3)

        events = self.log_events()
        self.assertEqual([ev["type"] for ev in events].count("compensate"), 1)
        self.assertNotIn("failed", [ev["type"] for ev in events])

        self.assertEqual(self.run_cli("recover").returncode, 0)
        st = self.state()
        self.assertEqual(st["status"], "FAILED")
        self.assertEqual(st["fail_count"], 2)
        self.assertEqual(st["compensated"], ["p1"])  # compensated exactly once
        kinds = [ev["type"] for ev in self.log_events()]
        self.assertEqual(kinds.count("compensate"), 1)


class TestValidation(CliTestCase):
    def test_unknown_participant_rejected(self) -> None:
        self.start()
        proc = self.vote("ghost", "SUCCESS")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(self.state()["votes"], {})

    def test_invalid_quorum_rejected(self) -> None:
        proc = self.run_cli("start", "--participants", "p1", "p2", "--quorum", "3")
        self.assertEqual(proc.returncode, 2)

    def test_double_start_rejected(self) -> None:
        self.start()
        proc = self.run_cli("start", "--participants", "a", "b", "--quorum", "1")
        self.assertEqual(proc.returncode, 2)


class TestReferenceTallyEnumeration(unittest.TestCase):
    """Exhaustively compare against a small reference tally for every vote.

    For N in {2, 3} and every valid Q, enumerate every vote order and every
    SUCCESS/FAIL assignment; after each vote the rebuilt state must match the
    reference tally, and votes after a final state must exit with code 9.
    """

    def test_enumeration_matches_reference(self) -> None:
        checked = 0
        for n in (2, 3):
            participants = [f"p{i}" for i in range(n)]
            for q in range(1, n + 1):
                for order in itertools.permutations(participants):
                    for results in itertools.product(("SUCCESS", "FAIL"), repeat=n):
                        checked += self._run_sequence(participants, q, order, results)
        self.assertGreater(checked, 0)

    def _run_sequence(self, participants, q, order, results) -> int:
        n = len(participants)
        with tempfile.TemporaryDirectory() as tmp:
            ledger = consensus.Ledger(os.path.join(tmp, "log.jsonl"))
            ledger.append({"type": "start", "participants": list(participants), "quorum": q})
            votes: dict[str, str] = {}
            for pid, result in zip(order, results):
                already_final = reference_status(votes, n, q) != "COLLECTING"
                st = consensus.rebuild(ledger.events)
                try:
                    consensus.apply_vote(ledger, st, pid, result)
                    code = 0
                except consensus.VoteError as exc:
                    code = exc.code
                if already_final:
                    self.assertEqual(code, 9, f"late vote must exit 9: {order} {results}")
                else:
                    self.assertEqual(code, 0, f"vote rejected: {order} {results}")
                    votes[pid] = result
                st = consensus.rebuild(ledger.events)
                expected = reference_status(votes, n, q)
                self.assertEqual(
                    st.status,
                    expected,
                    f"status mismatch after {votes} (N={n} Q={q})",
                )
                self.assertEqual(st.success_count(), sum(1 for r in votes.values() if r == "SUCCESS"))
                self.assertEqual(st.fail_count(), sum(1 for r in votes.values() if r == "FAIL"))
                if expected == "COMPLETED":
                    self.assertEqual(
                        sorted(st.canceled),
                        sorted(p for p in participants if p not in votes),
                    )
                if expected == "FAILED":
                    self.assertEqual(
                        sorted(st.compensated),
                        sorted(p for p, r in votes.items() if r == "SUCCESS"),
                    )
        return 1


if __name__ == "__main__":
    unittest.main()
