"""Supplier selection saga with crash recovery and idempotent side effects.

States: QUOTING -> RESERVING -> COMPLETED | FAILED
        QUOTING/RESERVING/COMPLETED --cancel--> CANCELING -> CANCELED

Semantics:
  1. Quotes are collected for all suppliers (logically concurrently); failed
     quotes are excluded from candidacy.
  2. Candidates are sorted by price ascending, ties broken by id ascending.
  3. Reservations are attempted in candidate order; the first success becomes
     the final supplier, failures fall back to the next candidate.
  4. No usable quotes -> FAILED.
  5. Cancel before RESERVING reserves nothing; cancel after a reservation
     compensates (releases) the reserved supplier.
  6. Every quote/reserve/release side effect is idempotent by request key,
     so crash + recover never duplicates a side effect.
"""

import argparse
import json
import os
import sys

TERMINAL_STATES = {"COMPLETED", "CANCELED", "FAILED"}


class Crash(Exception):
    """Simulated crash: side effect done, journal commit not done."""

    def __init__(self, event):
        super().__init__(event)
        self.event = event


# ---------------------------------------------------------------- persistence

def load_db(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_db(path, db):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(db, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


def load_suppliers(path):
    with open(path, "r", encoding="utf-8") as fh:
        suppliers = json.load(fh)
    for s in suppliers:
        s["id"] = str(s["id"])
        s.setdefault("latency", 0)
        s.setdefault("quote_fails", False)
        s.setdefault("reserve_fails", False)
    return suppliers


def new_saga(saga_id, suppliers):
    return {
        "saga_id": saga_id,
        "status": "QUOTING",
        "suppliers": suppliers,
        "cancel_requested": False,
        "crashed": False,
        "quotes": {},        # supplier id -> {"ok": bool, "price": number}
        "reserved": [],      # supplier ids currently held
        "released": [],      # supplier ids compensated
        "final_supplier": None,
        "journal": [],       # committed event names, e.g. "quote:A"
        "ledger": {},        # request key -> result (the durable "backend")
        "calls": {},         # request key -> real side-effect execution count
        "trace": [],         # {"event": ..., "status": ...} per event/transition
    }


# ------------------------------------------------------------------ internals

def _key(db, kind, sid):
    return "%s:%s:%s" % (kind, db["saga_id"], sid)


def _supplier(db, sid):
    for s in db["suppliers"]:
        if s["id"] == sid:
            return s
    raise KeyError("unknown supplier %r" % sid)


def candidates(db):
    """Reference candidate enumeration: usable quotes sorted by (price, id)."""
    usable = [s for s in db["suppliers"]
              if db["quotes"].get(s["id"], {}).get("ok")]
    return sorted(usable, key=lambda s: (s["price"], s["id"]))


def _execute(db, kind, sid):
    """Idempotent side effect keyed by request key.

    The ledger models the durable backend: if the key is present the stored
    result is returned and no real side effect is executed again.
    """
    key = _key(db, kind, sid)
    if key not in db["ledger"]:
        db["calls"][key] = db["calls"].get(key, 0) + 1
        s = _supplier(db, sid)
        if kind == "quote":
            db["ledger"][key] = {"ok": not s["quote_fails"], "price": s["price"]}
        elif kind == "reserve":
            db["ledger"][key] = {"ok": not s["reserve_fails"]}
        elif kind == "release":
            db["ledger"][key] = {"ok": True}
        else:  # pragma: no cover
            raise ValueError("unknown event kind %r" % kind)
    return db["ledger"][key]


def _transition(db, new_status):
    db["status"] = new_status
    db["trace"].append({"event": "state:" + new_status, "status": new_status})


def _apply_event(db, kind, sid, crash_at=None):
    name = "%s:%s" % (kind, sid)
    if name in db["journal"]:
        return
    if crash_at == name:
        # Crash window: side effect is durable in the ledger, but the journal
        # commit never happens. Recover will re-attempt this event and the
        # idempotency key will absorb the duplicate.
        _execute(db, kind, sid)
        raise Crash(name)
    result = _execute(db, kind, sid)
    if kind == "quote":
        db["quotes"][sid] = result
    elif kind == "reserve":
        if result["ok"]:
            db["reserved"].append(sid)
    elif kind == "release":
        if sid in db["reserved"]:
            db["reserved"].remove(sid)
        if sid not in db["released"]:
            db["released"].append(sid)
    db["journal"].append(name)
    db["trace"].append({"event": name, "status": db["status"]})


def _do_cancel(db, crash_at=None):
    if db["status"] != "CANCELING":
        _transition(db, "CANCELING")
    for sid in list(db["reserved"]):
        _apply_event(db, "release", sid, crash_at)
    db["final_supplier"] = None
    _transition(db, "CANCELED")


def advance(db, crash_at=None):
    """Drive the saga to a terminal state, optionally crashing at an event."""
    db["crashed"] = False
    while True:
        if (db["cancel_requested"]
                and db["status"] in ("QUOTING", "RESERVING", "COMPLETED",
                                     "CANCELING")):
            # Cancel before RESERVING reserves nothing; cancel after a
            # reservation compensates the held supplier(s). Ends in CANCELED.
            _do_cancel(db, crash_at)
            break
        if db["status"] in TERMINAL_STATES:
            break
        if db["status"] == "QUOTING":
            nxt = next((s for s in db["suppliers"]
                        if "quote:" + s["id"] not in db["journal"]), None)
            if nxt is None:
                if any(q["ok"] for q in db["quotes"].values()):
                    _transition(db, "RESERVING")
                else:
                    _transition(db, "FAILED")
            else:
                _apply_event(db, "quote", nxt["id"], crash_at)
        elif db["status"] == "RESERVING":
            nxt = next((c for c in candidates(db)
                        if "reserve:" + c["id"] not in db["journal"]), None)
            if nxt is None:
                _transition(db, "FAILED")
            else:
                _apply_event(db, "reserve", nxt["id"], crash_at)
                if nxt["id"] in db["reserved"]:
                    db["final_supplier"] = nxt["id"]
                    _transition(db, "COMPLETED")
        else:  # pragma: no cover
            raise ValueError("unknown status %r" % db["status"])
    return db


def summary(db):
    return {
        "saga_id": db["saga_id"],
        "status": db["status"],
        "crashed": db["crashed"],
        "cancel_requested": db["cancel_requested"],
        "final_supplier": db["final_supplier"],
        "reserved": list(db["reserved"]),
        "released": list(db["released"]),
        "candidates": [s["id"] for s in candidates(db)],
        "journal": list(db["journal"]),
        "calls": dict(db["calls"]),
    }


# ------------------------------------------------------------------------ CLI

def _open_or_init(args, need_suppliers=True):
    if os.path.exists(args.db):
        return load_db(args.db)
    if not args.suppliers:
        raise SystemExit("error: %s does not exist; pass --suppliers to start"
                         % args.db)
    db = new_saga(args.saga_id, load_suppliers(args.suppliers))
    save_db(args.db, db)
    return db


def cmd_run(args):
    db = _open_or_init(args)
    advance(db)
    save_db(args.db, db)
    print(json.dumps(summary(db), indent=2, sort_keys=True))
    return 0


def cmd_crash(args):
    db = _open_or_init(args)
    try:
        advance(db, crash_at=args.at)
    except Crash as crash:
        db["crashed"] = True
        save_db(args.db, db)
        print("CRASH at event %s (status=%s)" % (crash.event, db["status"]),
              file=sys.stderr)
        return 1
    save_db(args.db, db)
    print("warning: crash point %r never reached; saga finished at %s"
          % (args.at, db["status"]), file=sys.stderr)
    return 2


def cmd_recover(args):
    if not os.path.exists(args.db):
        raise SystemExit("error: %s does not exist" % args.db)
    db = load_db(args.db)
    advance(db)
    save_db(args.db, db)
    print(json.dumps(summary(db), indent=2, sort_keys=True))
    return 0


def cmd_cancel(args):
    if not os.path.exists(args.db):
        raise SystemExit("error: %s does not exist" % args.db)
    db = load_db(args.db)
    db["cancel_requested"] = True
    advance(db)
    save_db(args.db, db)
    print(json.dumps(summary(db), indent=2, sort_keys=True))
    return 0


def cmd_state(args):
    if not os.path.exists(args.db):
        raise SystemExit("error: %s does not exist" % args.db)
    print(json.dumps(summary(load_db(args.db)), indent=2, sort_keys=True))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="saga", description="Supplier selection saga CLI")
    parser.add_argument("--db", default="saga-state.json",
                        help="path to the durable state file")
    parser.add_argument("--saga-id", default="saga-1")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="start/continue the saga to a terminal state")
    p_run.add_argument("--suppliers", help="JSON supplier list (first run only)")
    p_run.set_defaults(func=cmd_run)

    p_crash = sub.add_parser("crash", help="run and simulate a crash at an event")
    p_crash.add_argument("--at", required=True,
                         help="event name, e.g. quote:B, reserve:A, release:A")
    p_crash.add_argument("--suppliers", help="JSON supplier list (first run only)")
    p_crash.set_defaults(func=cmd_crash)

    p_recover = sub.add_parser("recover", help="resume a crashed saga")
    p_recover.set_defaults(func=cmd_recover)

    p_cancel = sub.add_parser("cancel", help="request cancellation")
    p_cancel.set_defaults(func=cmd_cancel)

    p_state = sub.add_parser("state", help="print current saga state")
    p_state.set_defaults(func=cmd_state)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
