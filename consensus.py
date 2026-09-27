#!/usr/bin/env python3
"""Quorum-based consensus ledger with crash recovery.

Commands: start, vote, crash, recover, state.

An append-only JSONL log is the single source of truth.  All state is
rebuilt by replaying the log, so recovery after a crash is exact.

States: COLLECTING -> FINALIZING -> COMPLETED
        COLLECTING -> FAILED
Participants that never voted are CANCELED on completion; participants
that voted SUCCESS are COMPENSATED when the consensus fails.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CRASH = 3
EXIT_CONFLICT = 4
EXIT_LATE = 9

SUCCESS = "SUCCESS"
FAIL = "FAIL"

COLLECTING = "COLLECTING"
FINALIZING = "FINALIZING"
COMPLETED = "COMPLETED"
FAILED = "FAILED"

CRASH_EVENTS = ("VOTE", "FINAL", "COMPENSATE")


class VoteError(Exception):
    """A vote was rejected; carries the CLI exit code."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class Ledger:
    """Append-only JSONL event log with fsync durability."""

    def __init__(self, path: str):
        self.path = path
        self.events: list[dict] = []
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        self.events.append(json.loads(line))

    def append(self, event: dict) -> None:
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        self.events.append(event)


class State:
    """State rebuilt purely from the event log."""

    def __init__(self) -> None:
        self.participants: list[str] = []
        self.quorum = 0
        self.votes: dict[str, str] = {}
        self.status = COLLECTING
        self.canceled: list[str] = []
        self.compensated: list[str] = []

    @property
    def started(self) -> bool:
        return bool(self.participants)

    def success_count(self) -> int:
        return sum(1 for r in self.votes.values() if r == SUCCESS)

    def fail_count(self) -> int:
        return sum(1 for r in self.votes.values() if r == FAIL)

    def success_threshold_met(self) -> bool:
        return self.started and self.success_count() >= self.quorum

    def failure_threshold_met(self) -> bool:
        # N - Q + 1 FAIL votes make success forever impossible.
        return self.started and self.fail_count() >= len(self.participants) - self.quorum + 1

    def decided(self) -> bool:
        return (
            self.status in (FINALIZING, COMPLETED, FAILED)
            or self.success_threshold_met()
            or self.failure_threshold_met()
        )

    def as_dict(self) -> dict:
        return {
            "status": self.status,
            "quorum": self.quorum,
            "participants": list(self.participants),
            "votes": dict(self.votes),
            "success_count": self.success_count(),
            "fail_count": self.fail_count(),
            "canceled": list(self.canceled),
            "compensated": list(self.compensated),
        }


def rebuild(events: list[dict]) -> State:
    st = State()
    for ev in events:
        kind = ev["type"]
        if kind == "start":
            st.participants = list(ev["participants"])
            st.quorum = int(ev["quorum"])
        elif kind == "vote":
            st.votes[ev["participant"]] = ev["result"]
        elif kind == "finalizing":
            st.status = FINALIZING
        elif kind == "cancel":
            st.canceled.append(ev["participant"])
        elif kind == "completed":
            st.status = COMPLETED
        elif kind == "compensate":
            st.compensated.append(ev["participant"])
        elif kind == "failed":
            st.status = FAILED
    return st


def maybe_crash(crashpoint_path: str | None, event: str) -> None:
    """If a crash is armed for `event`, die abruptly (simulated crash)."""
    if not crashpoint_path:
        return
    try:
        with open(crashpoint_path, encoding="utf-8") as fh:
            armed = fh.read().strip()
    except FileNotFoundError:
        return
    if armed == event:
        os.unlink(crashpoint_path)
        os._exit(EXIT_CRASH)


def finalize(ledger: Ledger, st: State, crashpoint_path: str | None = None) -> None:
    """Drive the protocol to its terminal state once a threshold is met.

    Idempotent: safe to re-run during recovery on a partially written log.
    """
    if st.success_threshold_met() and st.status != COMPLETED:
        if st.status != FINALIZING:
            ledger.append({"type": "finalizing"})
            st.status = FINALIZING
        maybe_crash(crashpoint_path, "FINAL")
        for p in st.participants:
            if p not in st.votes and p not in st.canceled:
                ledger.append({"type": "cancel", "participant": p})
                st.canceled.append(p)
        ledger.append({"type": "completed"})
        st.status = COMPLETED
    elif st.failure_threshold_met() and st.status != FAILED:
        for p, r in st.votes.items():
            if r == SUCCESS and p not in st.compensated:
                ledger.append({"type": "compensate", "participant": p})
                st.compensated.append(p)
                maybe_crash(crashpoint_path, "COMPENSATE")
        ledger.append({"type": "failed"})
        st.status = FAILED


def apply_vote(
    ledger: Ledger,
    st: State,
    participant: str,
    result: str,
    crashpoint_path: str | None = None,
) -> str:
    """Apply one vote; returns a human-readable outcome message."""
    if not st.started:
        raise VoteError(EXIT_USAGE, "consensus not started")
    if participant not in st.participants:
        raise VoteError(EXIT_USAGE, f"unknown participant: {participant}")
    if participant in st.votes:
        first = st.votes[participant]
        if first == result:
            return f"duplicate vote ignored; first result stands: {participant} {first}"
        raise VoteError(
            EXIT_CONFLICT,
            f"conflicting vote: {participant} already voted {first}, cannot switch to {result}",
        )
    if st.decided():
        raise VoteError(EXIT_LATE, "final state already determined; late vote rejected")
    ledger.append({"type": "vote", "participant": participant, "result": result})
    st.votes[participant] = result
    maybe_crash(crashpoint_path, "VOTE")
    finalize(ledger, st, crashpoint_path)
    return f"vote recorded: {participant} {result}"


def crashpoint_path_for(log_path: str) -> str:
    return log_path + ".crash"


def cmd_start(args: argparse.Namespace) -> int:
    ledger = Ledger(args.log)
    st = rebuild(ledger.events)
    if st.started:
        print("error: consensus already started", file=sys.stderr)
        return EXIT_USAGE
    participants = list(args.participants)
    if len(set(participants)) != len(participants):
        print("error: duplicate participant ids", file=sys.stderr)
        return EXIT_USAGE
    if not 1 <= args.quorum <= len(participants):
        print("error: quorum must satisfy 1 <= Q <= N", file=sys.stderr)
        return EXIT_USAGE
    ledger.append({"type": "start", "participants": participants, "quorum": args.quorum})
    print(f"started: N={len(participants)} Q={args.quorum} state={COLLECTING}")
    return EXIT_OK


def cmd_vote(args: argparse.Namespace) -> int:
    ledger = Ledger(args.log)
    st = rebuild(ledger.events)
    result = args.result.upper()
    if result not in (SUCCESS, FAIL):
        print("error: result must be SUCCESS or FAIL", file=sys.stderr)
        return EXIT_USAGE
    try:
        message = apply_vote(ledger, st, args.id, result, crashpoint_path_for(args.log))
    except VoteError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return exc.code
    print(message)
    print(f"state={rebuild(ledger.events).status}")
    return EXIT_OK


def cmd_crash(args: argparse.Namespace) -> int:
    event = args.at.upper()
    if event not in CRASH_EVENTS:
        print(f"error: crash event must be one of {CRASH_EVENTS}", file=sys.stderr)
        return EXIT_USAGE
    with open(crashpoint_path_for(args.log), "w", encoding="utf-8") as fh:
        fh.write(event)
    print(f"crash armed at {event}; next matching event will crash the process")
    return EXIT_OK


def cmd_recover(args: argparse.Namespace) -> int:
    ledger = Ledger(args.log)
    st = rebuild(ledger.events)
    if not st.started:
        print("error: consensus not started", file=sys.stderr)
        return EXIT_USAGE
    finalize(ledger, st)  # converge whatever was interrupted; no crashpoints
    st = rebuild(ledger.events)
    print(json.dumps(st.as_dict(), sort_keys=True))
    return EXIT_OK


def cmd_state(args: argparse.Namespace) -> int:
    ledger = Ledger(args.log)
    st = rebuild(ledger.events)
    print(json.dumps(st.as_dict(), sort_keys=True))
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--log", default="consensus.log", help="path to the event log")
    parser = argparse.ArgumentParser(prog="consensus", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("start", parents=[common], help="start a consensus round")
    p.add_argument("--participants", nargs="+", required=True, help="participant ids")
    p.add_argument("--quorum", type=int, required=True, help="required SUCCESS votes Q")
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("vote", parents=[common], help="submit a vote")
    p.add_argument("id", help="participant id")
    p.add_argument("result", help="SUCCESS or FAIL")
    p.set_defaults(func=cmd_vote)

    p = sub.add_parser("crash", parents=[common], help="arm a one-shot crash point")
    p.add_argument("--at", required=True, help="VOTE, FINAL or COMPENSATE")
    p.set_defaults(func=cmd_crash)

    p = sub.add_parser("recover", parents=[common], help="rebuild from log and converge")
    p.set_defaults(func=cmd_recover)

    p = sub.add_parser("state", parents=[common], help="print current state as JSON")
    p.set_defaults(func=cmd_state)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
