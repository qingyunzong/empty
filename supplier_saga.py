#!/usr/bin/env python3
"""Supplier selection saga with crash recovery.

States: QUOTING -> RESERVING -> COMPLETED | FAILED | CANCELED (via CANCELING).

The saga journals every event to a JSON db file so that a crash at any
event can be recovered by re-entering the state machine. Quote, reserve
and compensate requests are idempotent: each is keyed and issued at most
once, recorded in the journal's ``requests`` log.

CLI:
    run      --suppliers S.json --db J.json      start a new saga
    crash    --suppliers S.json --db J.json --at EVENT   run, crash after EVENT
    recover  --db J.json [--at EVENT]            resume a crashed saga
    cancel   --db J.json                         request cancellation
    state    --db J.json                         print current state as JSON

Crash/recover event keys:
    quote:<id>         after the quote result of supplier <id> is journaled
    quotes             after the quote-collection phase is journaled done
    reserve:<id>       after a successful reservation of <id> is journaled
    reserve_fail:<id>  after a failed reservation attempt of <id> is journaled
    compensate:<id>    after compensation of <id> is journaled
"""
import argparse
import json
import os
import sys

TERMINAL_STATES = {"COMPLETED", "CANCELED", "FAILED"}


class CrashPointReached(Exception):
    """Simulates a process crash right after a journaled event."""

    def __init__(self, key):
        super().__init__(key)
        self.key = key


def new_db(suppliers):
    return {
        "state": "QUOTING",
        "suppliers": suppliers,
        "events": [],
        "requests": [],
        "chosen": None,
    }


def load_db(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_db(path, db):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(db, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


def event_key(event):
    etype = event["type"]
    if etype == "quote":
        return "quote:%s" % event["id"]
    if etype == "quotes_done":
        return "quotes"
    if etype == "reserve_ok":
        return "reserve:%s" % event["id"]
    if etype == "reserve_fail":
        return "reserve_fail:%s" % event["id"]
    if etype == "compensated":
        return "compensate:%s" % event["id"]
    if etype == "cancel_requested":
        return "cancel"
    return etype


def append_event(db, event, crash_at=None):
    db["events"].append(event)
    if crash_at is not None and event_key(event) == crash_at:
        raise CrashPointReached(crash_at)


def issue_request(db, kind, supplier_id):
    """Idempotent request issue: returns True only the first time."""
    key = "%s:%s" % (kind, supplier_id)
    if key in db["requests"]:
        return False
    db["requests"].append(key)
    return True


def cancel_requested(db):
    return any(e["type"] == "cancel_requested" for e in db["events"])


def candidates(db):
    """Reference candidate enumeration: usable quotes sorted by (price, id)."""
    usable = [e for e in db["events"] if e["type"] == "quote" and e["ok"]]
    usable.sort(key=lambda e: (e["price"], e["id"]))
    return [e["id"] for e in usable]


def _supplier_map(db):
    return {s["id"]: s for s in db["suppliers"]}


def _has_event(db, etype, supplier_id=None):
    for e in db["events"]:
        if e["type"] == etype and (supplier_id is None or e.get("id") == supplier_id):
            return True
    return False


def advance(db, crash_at=None):
    """Drive the state machine as far as possible.

    Raises CrashPointReached if crash_at matches a journaled event.
    """
    suppliers = _supplier_map(db)
    while True:
        state = db["state"]
        if state == "QUOTING":
            # Concurrent collection simulated by completion order (latency, id).
            for sup in sorted(db["suppliers"], key=lambda s: (s["latency"], s["id"])):
                if _has_event(db, "quote", sup["id"]):
                    continue  # already journaled: idempotent, do not re-request
                issue_request(db, "quote", sup["id"])
                append_event(db, {
                    "type": "quote",
                    "id": sup["id"],
                    "ok": not sup["quote_failed"],
                    "price": sup["price"],
                }, crash_at)
            if not _has_event(db, "quotes_done"):
                append_event(db, {"type": "quotes_done"}, crash_at)
            if cancel_requested(db):
                db["state"] = "CANCELED"  # canceled before RESERVING: reserve nothing
                continue
            if not candidates(db):
                db["state"] = "FAILED"  # no usable quotes
                continue
            db["state"] = "RESERVING"
            continue
        if state == "RESERVING":
            reserved = [e for e in db["events"] if e["type"] == "reserve_ok"]
            if reserved:
                # Recovery path: a reservation was journaled before the crash.
                db["chosen"] = reserved[0]["id"]
                db["state"] = "COMPLETED"
                continue
            if cancel_requested(db) and not _has_event(db, "reserve_ok"):
                db["state"] = "CANCELED"
                continue
            progressed = False
            for cand in candidates(db):
                if _has_event(db, "reserve_ok", cand) or _has_event(db, "reserve_fail", cand):
                    continue  # already attempted: idempotent
                issue_request(db, "reserve", cand)
                if suppliers[cand]["reserve_failed"]:
                    append_event(db, {"type": "reserve_fail", "id": cand}, crash_at)
                else:
                    db["chosen"] = cand
                    db["state"] = "COMPLETED"
                    append_event(db, {"type": "reserve_ok", "id": cand}, crash_at)
                progressed = True
                break
            if not progressed:
                db["state"] = "FAILED"  # every candidate failed to reserve
            continue
        if state == "COMPLETED":
            if cancel_requested(db) and not _has_event(db, "compensated"):
                db["state"] = "CANCELING"  # compensate the reserved supplier
                continue
            return
        if state == "CANCELING":
            chosen = db["chosen"]
            if not _has_event(db, "compensated", chosen):
                issue_request(db, "compensate", chosen)
                append_event(db, {"type": "compensated", "id": chosen}, crash_at)
            db["state"] = "CANCELED"
            continue
        if state in TERMINAL_STATES:
            return
        raise ValueError("unknown state: %r" % state)


def snapshot(db):
    return {
        "state": db["state"],
        "chosen": db["chosen"],
        "candidates": candidates(db),
        "events": [event_key(e) for e in db["events"]],
        "requests": list(db["requests"]),
    }


def _load_suppliers(path):
    with open(path, "r", encoding="utf-8") as fh:
        suppliers = json.load(fh)
    for sup in suppliers:
        for field in ("id", "price", "latency", "quote_failed", "reserve_failed"):
            if field not in sup:
                raise SystemExit("supplier %r missing field %r" % (sup, field))
    return suppliers


def _run_fresh(args, crash_at=None):
    db = new_db(_load_suppliers(args.suppliers))
    try:
        advance(db, crash_at)
    except CrashPointReached as crash:
        save_db(args.db, db)
        print("crashed at %s" % crash.key)
        print(json.dumps(snapshot(db), indent=2, sort_keys=True))
        return 0
    if crash_at is not None:
        save_db(args.db, db)
        print("crash point %r never reached" % crash_at, file=sys.stderr)
        return 1
    save_db(args.db, db)
    print(json.dumps(snapshot(db), indent=2, sort_keys=True))
    return 0


def cmd_run(args):
    return _run_fresh(args)


def cmd_crash(args):
    return _run_fresh(args, crash_at=args.at)


def cmd_recover(args):
    if not os.path.exists(args.db):
        print("no journal at %s" % args.db, file=sys.stderr)
        return 1
    db = load_db(args.db)
    try:
        advance(db, args.at)
    except CrashPointReached as crash:
        save_db(args.db, db)
        print("crashed at %s" % crash.key)
        print(json.dumps(snapshot(db), indent=2, sort_keys=True))
        return 0
    if args.at is not None:
        save_db(args.db, db)
        print("crash point %r never reached" % args.at, file=sys.stderr)
        return 1
    save_db(args.db, db)
    print(json.dumps(snapshot(db), indent=2, sort_keys=True))
    return 0


def cmd_cancel(args):
    if not os.path.exists(args.db):
        print("no journal at %s" % args.db, file=sys.stderr)
        return 1
    db = load_db(args.db)
    if db["state"] not in ("CANCELED", "FAILED") and not cancel_requested(db):
        append_event(db, {"type": "cancel_requested"})
    advance(db)
    save_db(args.db, db)
    print(json.dumps(snapshot(db), indent=2, sort_keys=True))
    return 0


def cmd_state(args):
    if not os.path.exists(args.db):
        print("no journal at %s" % args.db, file=sys.stderr)
        return 1
    print(json.dumps(snapshot(load_db(args.db)), indent=2, sort_keys=True))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="supplier_saga", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_db(p):
        p.add_argument("--db", default="journal.json", help="journal file path")

    p_run = sub.add_parser("run", help="start a new saga")
    p_run.add_argument("--suppliers", required=True)
    add_db(p_run)
    p_run.set_defaults(func=cmd_run)

    p_crash = sub.add_parser("crash", help="start a new saga and crash at an event")
    p_crash.add_argument("--suppliers", required=True)
    p_crash.add_argument("--at", required=True, help="event key to crash after")
    add_db(p_crash)
    p_crash.set_defaults(func=cmd_crash)

    p_recover = sub.add_parser("recover", help="resume a crashed saga")
    p_recover.add_argument("--at", default=None, help="optionally crash again at event")
    add_db(p_recover)
    p_recover.set_defaults(func=cmd_recover)

    p_cancel = sub.add_parser("cancel", help="request cancellation")
    add_db(p_cancel)
    p_cancel.set_defaults(func=cmd_cancel)

    p_state = sub.add_parser("state", help="print current state")
    add_db(p_state)
    p_state.set_defaults(func=cmd_state)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
