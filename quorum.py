"""Quorum commit protocol CLI.

A request is created with N participant ids and a success quorum Q.
Participants submit SUCCESS/FAIL votes through the CLI. All facts are
persisted as an append-only JSONL event log (the ledger); the in-memory
tally is always rebuilt by replaying the log, so recovery after a crash
is exact.

States: COLLECTING -> FINALIZING -> COMPLETED
        COLLECTING -> FAILED
CANCELED is the terminal outcome of participants who never voted when the
request completed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

COLLECTING = "COLLECTING"
FINALIZING = "FINALIZING"
COMPLETED = "COMPLETED"
CANCELED = "CANCELED"
FAILED = "FAILED"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CONFLICT = 4
EXIT_LATE_VOTE = 9
EXIT_CRASH = 70  # simulated crash (process dies right after the event is persisted)

CRASH_EVENTS = ("vote", "final", "compensate")

SUCCESS = "SUCCESS"
FAIL = "FAIL"


class Ledger:
    """Append-only JSONL event log with fsync durability."""

    def __init__(self, path):
        self.path = Path(path)

    def append(self, event):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def events(self):
        if not self.path.exists():
            return []
        out = []
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def reset(self):
        if self.path.exists():
            self.path.unlink()


class Tally:
    """In-memory projection rebuilt purely from the event log."""

    def __init__(self, participants, quorum):
        self.participants = list(participants)
        self.quorum = quorum
        self.votes = {}          # participant -> SUCCESS | FAIL (first vote wins)
        self.finalizing = False
        self.terminal = None     # COMPLETED | FAILED
        self.cancels = []        # participants canceled (never voted, request completed)
        self.compensations = []  # success voters compensated after FAILED

    @property
    def n(self):
        return len(self.participants)

    @property
    def successes(self):
        return sum(1 for v in self.votes.values() if v == SUCCESS)

    @property
    def failures(self):
        return sum(1 for v in self.votes.values() if v == FAIL)

    @property
    def fail_threshold(self):
        # N - Q + 1 failures make reaching Q successes impossible.
        return self.n - self.quorum + 1

    @property
    def state(self):
        if self.terminal is not None:
            return self.terminal
        if self.finalizing:
            return FINALIZING
        return COLLECTING

    def outcome(self, participant):
        if participant in self.votes:
            vote = self.votes[participant]
            if self.terminal == FAILED and vote == SUCCESS:
                return "COMPENSATED"
            if self.terminal == COMPLETED and vote == SUCCESS:
                return "COMMITTED"
            return vote + "_RECORDED" if self.terminal is None else vote
        if self.terminal == COMPLETED:
            return CANCELED
        return "PENDING"


def replay(events):
    """Rebuild the tally from the event log."""
    tally = None
    for ev in events:
        kind = ev["type"]
        if kind == "start":
            tally = Tally(ev["participants"], ev["quorum"])
        elif kind == "vote":
            if tally is not None and ev["participant"] not in tally.votes:
                tally.votes[ev["participant"]] = ev["vote"]
        elif kind == "finalizing":
            tally.finalizing = True
        elif kind == "completed":
            tally.terminal = COMPLETED
        elif kind == "failed":
            tally.terminal = FAILED
        elif kind == "cancel":
            tally.cancels.append(ev["participant"])
        elif kind == "compensate":
            tally.compensations.append(ev["participant"])
    return tally


def drive(ledger, tally, crash_hook):
    """Converge the ledger once a threshold is met; idempotent, so it is
    also the recovery procedure.

    Semantics:
      * successes >= Q  -> persist FINALIZING, then COMPLETED, then cancel
        every participant that never voted.
      * failures >= N-Q+1 -> persist FAILED, then compensate every
        participant that voted SUCCESS.
    """
    if tally.terminal is None:
        if tally.successes >= tally.quorum:
            if not tally.finalizing:
                ledger.append({"type": "finalizing"})
                tally.finalizing = True
            ledger.append({"type": "completed"})
            tally.terminal = COMPLETED
            crash_hook("final")
        elif tally.failures >= tally.fail_threshold:
            ledger.append({"type": "failed"})
            tally.terminal = FAILED
            crash_hook("final")
    if tally.terminal == COMPLETED:
        for p in tally.participants:
            if p not in tally.votes and p not in tally.cancels:
                ledger.append({"type": "cancel", "participant": p})
                tally.cancels.append(p)
    elif tally.terminal == FAILED:
        for p in tally.participants:
            if tally.votes.get(p) == SUCCESS and p not in tally.compensations:
                ledger.append({"type": "compensate", "participant": p})
                tally.compensations.append(p)
                crash_hook("compensate")


def crash_file_path(ledger_path):
    return Path(str(ledger_path) + ".crash")


def make_crash_hook(ledger_path):
    """Crash (die abruptly) right after the next persisted event whose type
    matches the directive set by `crash --at EVENT`."""
    def hook(event_kind):
        directive = crash_file_path(ledger_path)
        if directive.exists() and directive.read_text(encoding="utf-8").strip() == event_kind:
            os._exit(EXIT_CRASH)  # simulated crash: no cleanup, no further events
    return hook


def load_tally(ledger):
    return replay(ledger.events())


def snapshot(tally):
    return {
        "state": tally.state,
        "quorum": tally.quorum,
        "participants": tally.participants,
        "votes": dict(tally.votes),
        "successes": tally.successes,
        "failures": tally.failures,
        "fail_threshold": tally.fail_threshold,
        "cancels": list(tally.cancels),
        "compensations": list(tally.compensations),
        "outcomes": {p: tally.outcome(p) for p in tally.participants},
    }


def cmd_start(args):
    ledger = Ledger(args.ledger)
    if ledger.path.exists() and ledger.events():
        if not args.force:
            print("error: ledger already started (use --force to reset)", file=sys.stderr)
            return EXIT_USAGE
        ledger.reset()
    participants = args.participants
    if len(participants) != len(set(participants)):
        print("error: duplicate participant ids", file=sys.stderr)
        return EXIT_USAGE
    if not 1 <= args.quorum <= len(participants):
        print("error: quorum must satisfy 1 <= Q <= N", file=sys.stderr)
        return EXIT_USAGE
    ledger.append({"type": "start", "participants": participants, "quorum": args.quorum})
    print(json.dumps({"started": True, "state": COLLECTING,
                      "participants": participants, "quorum": args.quorum}, sort_keys=True))
    return EXIT_OK


def cmd_vote(args):
    ledger = Ledger(args.ledger)
    tally = load_tally(ledger)
    if tally is None:
        print("error: request not started", file=sys.stderr)
        return EXIT_USAGE
    pid, vote = args.participant, args.vote
    if pid not in tally.participants:
        print(f"error: unknown participant {pid!r}", file=sys.stderr)
        return EXIT_USAGE
    previous = tally.votes.get(pid)
    if previous == vote:
        # Duplicate vote: return the first result, ledger untouched.
        print(json.dumps({"participant": pid, "vote": vote, "duplicate": True,
                          "first_result": previous, "state": tally.state}, sort_keys=True))
        return EXIT_OK
    if tally.terminal is not None:
        # Late vote after the final state is sealed: exit 9, ledger untouched.
        print(json.dumps({"participant": pid, "vote": vote, "late": True,
                          "state": tally.state}, sort_keys=True))
        return EXIT_LATE_VOTE
    if previous is not None:
        # Same participant, opposite vote: conflict, ledger untouched.
        print(json.dumps({"participant": pid, "vote": vote, "conflict": True,
                          "first_result": previous, "state": tally.state}, sort_keys=True))
        return EXIT_CONFLICT
    ledger.append({"type": "vote", "participant": pid, "vote": vote})
    tally.votes[pid] = vote
    make_crash_hook(ledger.path)("vote")
    drive(ledger, tally, make_crash_hook(ledger.path))
    print(json.dumps({"participant": pid, "vote": vote, "accepted": True,
                      "state": tally.state}, sort_keys=True))
    return EXIT_OK


def cmd_crash(args):
    if args.at not in CRASH_EVENTS:
        print(f"error: crash event must be one of {CRASH_EVENTS}", file=sys.stderr)
        return EXIT_USAGE
    crash_file_path(args.ledger).write_text(args.at, encoding="utf-8")
    print(json.dumps({"crash_armed_at": args.at}, sort_keys=True))
    return EXIT_OK


def cmd_recover(args):
    directive = crash_file_path(args.ledger)
    if directive.exists():
        directive.unlink()
    ledger = Ledger(args.ledger)
    tally = load_tally(ledger)
    if tally is None:
        print("error: request not started", file=sys.stderr)
        return EXIT_USAGE
    drive(ledger, tally, lambda kind: None)  # replay-driven convergence, no crash hook
    snap = snapshot(tally)
    snap["recovered"] = True
    print(json.dumps(snap, sort_keys=True))
    return EXIT_OK


def cmd_state(args):
    ledger = Ledger(args.ledger)
    tally = load_tally(ledger)
    if tally is None:
        print("error: request not started", file=sys.stderr)
        return EXIT_USAGE
    print(json.dumps(snapshot(tally), sort_keys=True))
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(prog="quorum", description=__doc__)
    parser.add_argument("--ledger", default="ledger.jsonl", help="event log path")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("start", help="start a request with participant ids and quorum Q")
    p.add_argument("--participants", nargs="+", required=True)
    p.add_argument("--quorum", type=int, required=True)
    p.add_argument("--force", action="store_true", help="reset an existing ledger")
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("vote", help="submit a vote: vote ID SUCCESS|FAIL")
    p.add_argument("participant")
    p.add_argument("vote", choices=[SUCCESS, FAIL])
    p.set_defaults(func=cmd_vote)

    p = sub.add_parser("crash", help="arm a crash after the next EVENT is persisted")
    p.add_argument("--at", required=True, choices=list(CRASH_EVENTS))
    p.set_defaults(func=cmd_crash)

    p = sub.add_parser("recover", help="rebuild tallies from the log and finish interrupted work")
    p.set_defaults(func=cmd_recover)

    p = sub.add_parser("state", help="print current state as JSON")
    p.set_defaults(func=cmd_state)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
