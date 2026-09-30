#!/usr/bin/env python3
"""request_flow: approval workflow CLI with event sourcing and crash recovery.

A request carries an amount, reserved items and a virtual timeout (ticks).
Amount >= 1000 requires manager + finance approval, otherwise manager only.

States: RUNNING, APPROVED, REJECTING, REJECTED, TIMEOUT_CANCELING,
CANCELED, FAILED.

Commands: new, tick, decide APPROVER DECISION, crash --at, recover, state,
events.
"""
import argparse
import json
import os
import sys

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_NOT_DECIDABLE = 4
EXIT_CONFLICT = 9
EXIT_CRASH = 10

MANAGER = "manager"
FINANCE = "finance"
APPROVERS = (MANAGER, FINANCE)
APPROVE = "APPROVE"
REJECT = "REJECT"
DECISIONS = (APPROVE, REJECT)

HIGH_AMOUNT_THRESHOLD = 1000

RUNNING = "RUNNING"
APPROVED = "APPROVED"
REJECTING = "REJECTING"
REJECTED = "REJECTED"
TIMEOUT_CANCELING = "TIMEOUT_CANCELING"
CANCELED = "CANCELED"
FAILED = "FAILED"

CRASH_AFTER_DECISION_EVENT = "after-decision-event"
CRASH_MID_COMPENSATION = "mid-compensation"
CRASH_POINTS = (CRASH_AFTER_DECISION_EVENT, CRASH_MID_COMPENSATION)

EVENTS_FILE = "events.jsonl"
CRASH_FILE = "crash.json"


class SimulatedCrash(Exception):
    def __init__(self, point):
        super().__init__(point)
        self.point = point


def events_path(home):
    return os.path.join(home, EVENTS_FILE)


def crash_path(home):
    return os.path.join(home, CRASH_FILE)


def load_events(home):
    path = events_path(home)
    if not os.path.exists(path):
        return []
    events = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def append_event(home, event):
    os.makedirs(home, exist_ok=True)
    event = dict(event)
    event["seq"] = len(load_events(home)) + 1
    with open(events_path(home), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return event


def arm_crash(home, point):
    os.makedirs(home, exist_ok=True)
    with open(crash_path(home), "w", encoding="utf-8") as fh:
        json.dump({"at": point}, fh)


def maybe_crash(home, point):
    path = crash_path(home)
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        armed = json.load(fh)
    if armed.get("at") == point:
        os.remove(path)
        raise SimulatedCrash(point)


def required_approvers(amount):
    if amount >= HIGH_AMOUNT_THRESHOLD:
        return [MANAGER, FINANCE]
    return [MANAGER]


def project(home):
    """Replay the event log into a state projection."""
    proj = {
        "created": False,
        "amount": None,
        "timeout": None,
        "reserved": [],
        "compensated": [],
        "decisions": {},
        "ticks": 0,
        "state": None,
    }
    try:
        events = load_events(home)
    except (json.JSONDecodeError, OSError):
        proj["state"] = FAILED
        return proj
    try:
        for ev in events:
            etype = ev["type"]
            if etype == "RequestCreated":
                proj["created"] = True
                proj["amount"] = ev["amount"]
                proj["timeout"] = ev["timeout"]
                proj["state"] = RUNNING
            elif etype == "ItemReserved":
                proj["reserved"].append(ev["item"])
            elif etype == "Tick":
                proj["ticks"] = ev["n"]
            elif etype == "DecisionRecorded":
                proj["decisions"][ev["approver"]] = ev["decision"]
            elif etype == "RejectingStarted":
                proj["state"] = REJECTING
            elif etype == "TimeoutCancelingStarted":
                proj["state"] = TIMEOUT_CANCELING
            elif etype == "ItemCompensated":
                proj["compensated"].append(ev["item"])
            elif etype == "Completed":
                proj["state"] = APPROVED
            elif etype == "Rejected":
                proj["state"] = REJECTED
            elif etype == "Canceled":
                proj["state"] = CANCELED
            else:
                proj["state"] = FAILED
                return proj
    except (KeyError, TypeError):
        proj["state"] = FAILED
    return proj


def drive(home):
    """Apply pending actions until the workflow is stable.

    Idempotent: already-compensated items are never compensated twice,
    so recovery after a crash between a decision event and its actions
    does not duplicate compensation.
    """
    proj = project(home)
    if proj["state"] in (None, FAILED, APPROVED, REJECTED, CANCELED):
        return proj
    if proj["state"] == RUNNING:
        decisions = proj["decisions"]
        if any(d == REJECT for d in decisions.values()):
            append_event(home, {"type": "RejectingStarted"})
            proj["state"] = REJECTING
        elif all(decisions.get(a) == APPROVE
                 for a in required_approvers(proj["amount"])):
            append_event(home, {"type": "Completed"})
            proj["state"] = APPROVED
            return proj
        elif (proj["timeout"] is not None
              and proj["ticks"] >= proj["timeout"]):
            append_event(home, {"type": "TimeoutCancelingStarted"})
            proj["state"] = TIMEOUT_CANCELING
    if proj["state"] in (REJECTING, TIMEOUT_CANCELING):
        done = set(proj["compensated"])
        for item in reversed(proj["reserved"]):
            if item in done:
                continue
            append_event(home, {"type": "ItemCompensated", "item": item})
            maybe_crash(home, CRASH_MID_COMPENSATION)
        final = "Rejected" if proj["state"] == REJECTING else "Canceled"
        append_event(home, {"type": final})
    return project(home)


def cmd_new(home, args):
    if os.path.exists(events_path(home)) and load_events(home):
        print("error: request already exists", file=sys.stderr)
        return EXIT_NOT_DECIDABLE
    append_event(home, {"type": "RequestCreated",
                        "amount": args.amount, "timeout": args.timeout})
    for item in args.items.split(","):
        item = item.strip()
        if item:
            append_event(home, {"type": "ItemReserved", "item": item})
    print(RUNNING)
    return EXIT_OK


def cmd_tick(home, _args):
    proj = project(home)
    if not proj["created"]:
        print("error: no request", file=sys.stderr)
        return EXIT_NOT_DECIDABLE
    if proj["state"] != RUNNING:
        print("error: cannot tick in state %s" % proj["state"], file=sys.stderr)
        return EXIT_NOT_DECIDABLE
    append_event(home, {"type": "Tick", "n": proj["ticks"] + 1})
    proj = drive(home)
    print(proj["state"])
    return EXIT_OK


def cmd_decide(home, args):
    approver = args.approver.lower()
    decision = args.decision.upper()
    if approver not in APPROVERS or decision not in DECISIONS:
        print("error: invalid approver or decision", file=sys.stderr)
        return EXIT_USAGE
    proj = project(home)
    if not proj["created"]:
        print("error: no request", file=sys.stderr)
        return EXIT_NOT_DECIDABLE
    if approver not in required_approvers(proj["amount"]):
        print("error: approver %s not required" % approver, file=sys.stderr)
        return EXIT_NOT_DECIDABLE
    prev = proj["decisions"].get(approver)
    if prev is not None:
        if prev == decision:
            print(proj["state"])
            return EXIT_OK
        print("error: conflicting decision for %s" % approver, file=sys.stderr)
        return EXIT_CONFLICT
    if proj["state"] != RUNNING:
        print("error: request not decidable in state %s" % proj["state"],
              file=sys.stderr)
        return EXIT_NOT_DECIDABLE
    append_event(home, {"type": "DecisionRecorded",
                        "approver": approver, "decision": decision})
    maybe_crash(home, CRASH_AFTER_DECISION_EVENT)
    proj = drive(home)
    print(proj["state"])
    return EXIT_OK


def cmd_crash(home, args):
    arm_crash(home, args.at)
    print("crash armed at %s" % args.at)
    return EXIT_OK


def cmd_recover(home, _args):
    proj = drive(home)
    if proj["state"] is None:
        print("error: no request", file=sys.stderr)
        return EXIT_NOT_DECIDABLE
    print(proj["state"])
    return EXIT_OK


def cmd_state(home, _args):
    proj = project(home)
    if proj["state"] is None:
        print("error: no request", file=sys.stderr)
        return EXIT_NOT_DECIDABLE
    print(proj["state"])
    return EXIT_OK


def cmd_events(home, _args):
    for ev in load_events(home):
        attrs = " ".join("%s=%s" % (k, v) for k, v in sorted(ev.items())
                         if k not in ("seq", "type"))
        line = "%d %s" % (ev["seq"], ev["type"])
        print(line + (" " + attrs if attrs else ""))
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(prog="request_flow")
    parser.add_argument("--dir", default=os.environ.get(
        "REQUEST_FLOW_HOME", ".rfstate"))
    sub = parser.add_subparsers(dest="command", required=True)

    p_new = sub.add_parser("new")
    p_new.add_argument("--amount", type=int, required=True)
    p_new.add_argument("--items", default="")
    p_new.add_argument("--timeout", type=int, default=None)

    sub.add_parser("tick")

    p_decide = sub.add_parser("decide")
    p_decide.add_argument("approver")
    p_decide.add_argument("decision")

    p_crash = sub.add_parser("crash")
    p_crash.add_argument("--at", choices=CRASH_POINTS, required=True)

    sub.add_parser("recover")
    sub.add_parser("state")
    sub.add_parser("events")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    handlers = {
        "new": cmd_new,
        "tick": cmd_tick,
        "decide": cmd_decide,
        "crash": cmd_crash,
        "recover": cmd_recover,
        "state": cmd_state,
        "events": cmd_events,
    }
    try:
        return handlers[args.command](args.dir, args)
    except SimulatedCrash as crash:
        print("CRASH at %s" % crash.point, file=sys.stderr)
        return EXIT_CRASH


if __name__ == "__main__":
    sys.exit(main())
