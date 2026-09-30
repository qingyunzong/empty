"""Approval workflow state machine CLI.

States: RUNNING, APPROVED, REJECTING, REJECTED, TIMEOUT_CANCELING, CANCELED, FAILED.

Semantics:
 1. All required approvals must pass before the request joins as APPROVED.
    amount >= 1000 requires manager + finance; otherwise manager only.
 2. Any rejection compensates reserved items in reverse order
    (REJECTING -> REJECTED).
 3. A tick reaching the deadline while undecided cancels and compensates
    (TIMEOUT_CANCELING -> CANCELED).
 4. Repeating the same decision by the same approver is idempotent; an
    opposite decision after a recorded one exits with code 9.
 5. A crash between the decision event and its actions is recovered without
    duplicating compensation (idempotent journal replay).

Commands: new, tick, decide APPROVER DECISION, crash --at, recover, state.
"""

import argparse
import json
import os
import sys

HIGH_AMOUNT_THRESHOLD = 1000
MANAGER = "manager"
FINANCE = "finance"

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CONFLICT = 9
EXIT_CRASH = 70

TERMINAL_STATES = {"APPROVED", "REJECTED", "CANCELED", "FAILED"}


def required_approvers(amount):
    if amount >= HIGH_AMOUNT_THRESHOLD:
        return [MANAGER, FINANCE]
    return [MANAGER]


def default_store():
    return {"tick": 0, "crash_at": None, "request": None, "journal": []}


def load_store(path):
    if not os.path.exists(path):
        return default_store()
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_store(path, store):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(store, fh, indent=2)
    os.replace(tmp, path)


def log_event(store, event_type, **fields):
    event = {"seq": len(store["journal"]) + 1, "tick": store["tick"], "type": event_type}
    event.update(fields)
    store["journal"].append(event)
    return event


def compensate_remaining(store, req, limit=None):
    """Compensate reserved items in reverse order, idempotently.

    Items already present in req["compensated"] are skipped, so recovery
    after a crash never compensates the same item twice. ``limit`` caps how
    many items are compensated in this call (used to simulate a crash in the
    middle of compensation).
    """
    done = []
    for item in reversed(req["items"]):
        if item in req["compensated"]:
            continue
        if limit is not None and len(done) >= limit:
            break
        log_event(store, "compensate", item=item)
        req["compensated"].append(item)
        done.append(item)
    return done


def apply_decision_effects(store, req, approver, decision):
    """Apply the state transitions/actions for a recorded decision."""
    events = []
    if decision == "reject":
        req["state"] = "REJECTING"
        log_event(store, "state", state="REJECTING", reason="rejected_by:" + approver)
        events.append("state=REJECTING")
        crash_mid = store.get("crash_at") == "mid-compensation"
        done = compensate_remaining(store, req, limit=1 if crash_mid else None)
        events.extend("compensate:" + i for i in done)
        if crash_mid and len(req["compensated"]) < len(req["items"]):
            return events, True  # crash mid-compensation, effects still pending
        req["state"] = "REJECTED"
        log_event(store, "state", state="REJECTED")
        events.append("state=REJECTED")
    else:
        needed = required_approvers(req["amount"])
        if all(req["decisions"].get(a) == "approve" for a in needed):
            req["state"] = "APPROVED"
            log_event(store, "state", state="APPROVED")
            events.append("state=APPROVED")
    return events, False


def cmd_new(args, store, path):
    items = [i for i in args.items.split(",") if i] if args.items else []
    req = {
        "id": args.id,
        "amount": args.amount,
        "items": items,
        "timeout": args.timeout,
        "state": "RUNNING",
        "decisions": {},
        "compensated": [],
        "pending_effects": None,
    }
    store["request"] = req
    store["tick"] = 0
    store["crash_at"] = None
    store["journal"] = []
    log_event(store, "new", id=req["id"], amount=req["amount"],
              items=items, timeout=req["timeout"],
              approvers=required_approvers(req["amount"]))
    log_event(store, "state", state="RUNNING")
    save_store(path, store)
    print("new request %s amount=%d timeout=%d items=%s approvers=%s state=RUNNING"
          % (req["id"], req["amount"], req["timeout"],
             ",".join(items) or "-", ",".join(required_approvers(req["amount"]))))
    return EXIT_OK


def cmd_tick(args, store, path):
    req = store["request"]
    if req is None:
        print("error: no request", file=sys.stderr)
        return EXIT_ERROR
    store["tick"] += 1
    events = []
    if req["state"] == "RUNNING" and store["tick"] >= req["timeout"]:
        log_event(store, "state", state="TIMEOUT_CANCELING", reason="deadline")
        req["state"] = "TIMEOUT_CANCELING"
        events.append("state=TIMEOUT_CANCELING")
        done = compensate_remaining(store, req)
        events.extend("compensate:" + i for i in done)
        req["state"] = "CANCELED"
        log_event(store, "state", state="CANCELED")
        events.append("state=CANCELED")
    save_store(path, store)
    print("tick=%d %s" % (store["tick"], " ".join(events) if events else "no-events"))
    return EXIT_OK


def cmd_decide(args, store, path):
    req = store["request"]
    if req is None:
        print("error: no request", file=sys.stderr)
        return EXIT_ERROR
    approver = args.approver
    decision = args.decision.lower()
    if decision not in ("approve", "reject"):
        print("error: decision must be approve or reject", file=sys.stderr)
        return EXIT_ERROR
    needed = required_approvers(req["amount"])
    if approver not in needed:
        print("error: approver %r not required for this request" % approver,
              file=sys.stderr)
        return EXIT_ERROR
    if approver in req["decisions"]:
        if req["decisions"][approver] == decision:
            print("duplicate decision %s=%s ignored (idempotent)" % (approver, decision))
            return EXIT_OK
        print("error: conflicting decision by %s (already %s)" % (approver, req["decisions"][approver]),
              file=sys.stderr)
        return EXIT_CONFLICT
    if req["state"] != "RUNNING":
        print("error: request not RUNNING (state=%s), decision refused" % req["state"],
              file=sys.stderr)
        return EXIT_ERROR

    # 1) Persist the decision event first (journal), then apply actions.
    req["decisions"][approver] = decision
    req["pending_effects"] = {"approver": approver, "decision": decision}
    log_event(store, "decision", approver=approver, decision=decision)
    save_store(path, store)

    if store.get("crash_at") == "after-decision":
        print("CRASH simulated after decision event (before actions)")
        return EXIT_CRASH

    # 2) Apply actions.
    events, crashed = apply_decision_effects(store, req, approver, decision)
    if crashed:
        save_store(path, store)
        print("decision %s=%s recorded; %s" % (approver, decision, " ".join(events)))
        print("CRASH simulated mid-compensation")
        return EXIT_CRASH
    req["pending_effects"] = None
    store["crash_at"] = None
    save_store(path, store)
    tail = " ".join(events) if events else "no-events"
    print("decision %s=%s applied; %s; final state=%s" % (approver, decision, tail, req["state"]))
    return EXIT_OK


def cmd_crash(args, store, path):
    if args.at not in ("after-decision", "mid-compensation"):
        print("error: --at must be after-decision or mid-compensation", file=sys.stderr)
        return EXIT_ERROR
    store["crash_at"] = args.at
    save_store(path, store)
    print("crash armed at %s (next decide will crash)" % args.at)
    return EXIT_OK


def cmd_recover(args, store, path):
    req = store["request"]
    if req is None:
        print("error: no request", file=sys.stderr)
        return EXIT_ERROR
    pending = req.get("pending_effects")
    if not pending:
        print("recover: nothing pending")
        store["crash_at"] = None
        save_store(path, store)
        return EXIT_OK
    store["crash_at"] = None
    events, _ = apply_decision_effects(store, req, pending["approver"], pending["decision"])
    req["pending_effects"] = None
    log_event(store, "recovered")
    save_store(path, store)
    tail = " ".join(events) if events else "no-events"
    print("recover: applied pending %s=%s; %s; final state=%s"
          % (pending["approver"], pending["decision"], tail, req["state"]))
    return EXIT_OK


def cmd_state(args, store, path):
    req = store["request"]
    if req is None:
        print("no request")
        return EXIT_OK
    print(json.dumps({
        "tick": store["tick"],
        "state": req["state"],
        "amount": req["amount"],
        "timeout": req["timeout"],
        "items": req["items"],
        "compensated": req["compensated"],
        "decisions": req["decisions"],
        "pending_effects": req["pending_effects"],
        "required_approvers": required_approvers(req["amount"]),
    }, indent=2))
    return EXIT_OK


def main(argv=None):
    parser = argparse.ArgumentParser(prog="approval_cli")
    parser.add_argument("--store", default="store.json", help="state file path")
    sub = parser.add_subparsers(dest="command", required=True)

    p_new = sub.add_parser("new")
    p_new.add_argument("--id", default="REQ-1")
    p_new.add_argument("--amount", type=int, required=True)
    p_new.add_argument("--timeout", type=int, required=True)
    p_new.add_argument("--items", default="", help="comma-separated reserved items")

    sub.add_parser("tick")

    p_decide = sub.add_parser("decide")
    p_decide.add_argument("approver")
    p_decide.add_argument("decision")

    p_crash = sub.add_parser("crash")
    p_crash.add_argument("--at", required=True)

    sub.add_parser("recover")
    sub.add_parser("state")

    args = parser.parse_args(argv)
    store = load_store(args.store)
    handlers = {
        "new": cmd_new, "tick": cmd_tick, "decide": cmd_decide,
        "crash": cmd_crash, "recover": cmd_recover, "state": cmd_state,
    }
    return handlers[args.command](args, store, args.store)


if __name__ == "__main__":
    sys.exit(main())
