#!/usr/bin/env python3
"""Idempotent two-account transfer CLI.

Storage layout inside --dir:
  request.json  - normalized transfer request (two accounts + idemkey)
  events.jsonl  - append-only event log (flush + fsync after every record)
  ledger.jsonl  - append-only ledger, entries deduplicated by idemkey+action
"""

import argparse
import json
import os
import sys

PENDING = "PENDING"
PREPARED = "PREPARED"
COMPLETED = "COMPLETED"
COMPENSATING = "COMPENSATING"
COMPENSATED = "COMPENSATED"
FAILED = "FAILED"

TERMINAL_STATES = (COMPLETED, COMPENSATED, FAILED)

EXIT_OK = 0            # success or compensation completed
EXIT_IN_PROGRESS = 2   # request still in progress
EXIT_PARAM = 4         # parameter error
EXIT_FAILED = 10       # permanent failure

STATUS_EXIT = {
    COMPLETED: EXIT_OK,
    COMPENSATED: EXIT_OK,
    PENDING: EXIT_IN_PROGRESS,
    PREPARED: EXIT_IN_PROGRESS,
    COMPENSATING: EXIT_IN_PROGRESS,
    FAILED: EXIT_FAILED,
}

CRASH_POINTS = ("after-debit-event", "after-debit-action", "after-credit-action")

STATE_BY_EVENT = {
    "transfer_created": PENDING,
    "debit_prepared": PREPARED,
    "debit_done": PREPARED,
    "credit_done": COMPLETED,
    "credit_failed": COMPENSATING,
    "refund_done": COMPENSATED,
    "refund_failed": FAILED,
}


class RequestError(Exception):
    pass


def append_jsonl(path, record):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def load_jsonl(path):
    if not os.path.exists(path):
        return []
    records = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def validate_request(data):
    if not isinstance(data, dict):
        raise RequestError("request must be a JSON object")
    idemkey = data.get("idemkey")
    if not isinstance(idemkey, str) or not idemkey:
        raise RequestError("idemkey must be a non-empty string")
    accounts = data.get("accounts")
    if not isinstance(accounts, dict) or len(accounts) != 2:
        raise RequestError("accounts must name exactly two accounts")
    for name, balance in accounts.items():
        if not isinstance(name, str) or not name:
            raise RequestError("account names must be non-empty strings")
        if not _is_int(balance) or balance < 0:
            raise RequestError("account balances must be non-negative integers")
    transfer = data.get("transfer")
    if not isinstance(transfer, dict):
        raise RequestError("transfer must be an object")
    src, dst = transfer.get("from"), transfer.get("to")
    amount = transfer.get("amount")
    if src not in accounts or dst not in accounts or src == dst:
        raise RequestError("transfer.from/to must be the two distinct accounts")
    if not _is_int(amount) or amount <= 0:
        raise RequestError("transfer.amount must be a positive integer")
    if amount > accounts[src]:
        raise RequestError("transfer.amount exceeds source balance")
    failures = data.get("failures", {})
    if not isinstance(failures, dict):
        raise RequestError("failures must be an object")
    return {
        "idemkey": idemkey,
        "accounts": dict(accounts),
        "transfer": {"from": src, "to": dst, "amount": amount},
        "failures": {
            "credit": bool(failures.get("credit", False)),
            "refund": bool(failures.get("refund", False)),
        },
    }


class System:
    def __init__(self, dirpath):
        self.dir = dirpath
        self.request_path = os.path.join(dirpath, "request.json")
        self.events_path = os.path.join(dirpath, "events.jsonl")
        self.ledger_path = os.path.join(dirpath, "ledger.jsonl")

    def exists(self):
        return os.path.exists(self.request_path)

    def create(self, request):
        os.makedirs(self.dir, exist_ok=True)
        with open(self.request_path, "w", encoding="utf-8") as fh:
            json.dump(request, fh, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        self.append_event({
            "event": "transfer_created",
            "idemkey": request["idemkey"],
            "from": request["transfer"]["from"],
            "to": request["transfer"]["to"],
            "amount": request["transfer"]["amount"],
        })

    def load_request(self):
        with open(self.request_path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def events(self):
        return load_jsonl(self.events_path)

    def ledger(self):
        return load_jsonl(self.ledger_path)

    def status(self):
        state = None
        for record in self.events():
            state = STATE_BY_EVENT.get(record.get("event"), state)
        return state

    def has_event(self, name):
        return any(r.get("event") == name for r in self.events())

    def balances(self):
        balances = dict(self.load_request()["accounts"])
        for entry in self.ledger():
            balances[entry["account"]] += entry["delta"]
        return balances

    def append_event(self, record):
        append_jsonl(self.events_path, record)

    def ledger_apply(self, action, account, delta):
        """Append a ledger entry unless idemkey+action is already recorded."""
        idemkey = self.load_request()["idemkey"]
        for entry in self.ledger():
            if entry["idemkey"] == idemkey and entry["action"] == action:
                return False
        append_jsonl(self.ledger_path, {
            "idemkey": idemkey,
            "action": action,
            "account": account,
            "delta": delta,
        })
        return True

    def snapshot(self):
        request = self.load_request()
        return {
            "idemkey": request["idemkey"],
            "status": self.status(),
            "balances": self.balances(),
        }


def execute(system, crash_at=None):
    """Drive the state machine; every action is resumable from the event log."""
    request = system.load_request()
    idemkey = request["idemkey"]
    src = request["transfer"]["from"]
    dst = request["transfer"]["to"]
    amount = request["transfer"]["amount"]
    while True:
        state = system.status()
        if state in TERMINAL_STATES:
            return state
        if state == PENDING:
            system.append_event({
                "event": "debit_prepared", "idemkey": idemkey,
                "account": src, "amount": amount,
            })
            if crash_at == "after-debit-event":
                return system.status()
        elif state == PREPARED:
            if not system.has_event("debit_done"):
                system.ledger_apply("debit", src, -amount)
                if crash_at == "after-debit-action":
                    return system.status()
                system.append_event({
                    "event": "debit_done", "idemkey": idemkey,
                    "account": src, "amount": amount,
                })
            elif not system.has_event("credit_done"):
                if request["failures"]["credit"]:
                    system.append_event({
                        "event": "credit_failed", "idemkey": idemkey,
                        "account": dst, "amount": amount, "reason": "permanent",
                    })
                else:
                    system.ledger_apply("credit", dst, amount)
                    if crash_at == "after-credit-action":
                        return system.status()
                    system.append_event({
                        "event": "credit_done", "idemkey": idemkey,
                        "account": dst, "amount": amount,
                    })
        elif state == COMPENSATING:
            if not system.has_event("refund_done"):
                if request["failures"]["refund"]:
                    system.append_event({
                        "event": "refund_failed", "idemkey": idemkey,
                        "account": src, "amount": amount, "reason": "permanent",
                    })
                else:
                    system.ledger_apply("refund", src, amount)
                    system.append_event({
                        "event": "refund_done", "idemkey": idemkey,
                        "account": src, "amount": amount,
                    })


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"error: {message}", file=sys.stderr)
        sys.exit(EXIT_PARAM)


def build_parser():
    parser = Parser(prog="transfer.py", description="Idempotent transfer CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_new = sub.add_parser("new", help="create a transfer from a JSON request")
    p_new.add_argument("--request", required=True, help="path to request JSON")

    sub.add_parser("run", help="execute the transfer to a terminal state")

    p_crash = sub.add_parser("crash", help="execute then stop at a crash point")
    p_crash.add_argument("--at", required=True, choices=CRASH_POINTS)

    sub.add_parser("recover", help="resume from the event log")
    sub.add_parser("state", help="print status and balances")

    for p in sub.choices.values():
        p.add_argument("--dir", default="system", help="system directory")
    return parser


def _require_system(dirpath):
    system = System(dirpath)
    if not system.exists():
        print(f"error: no transfer system in {dirpath!r} (run 'new' first)",
              file=sys.stderr)
        sys.exit(EXIT_PARAM)
    return system


def cmd_new(args):
    try:
        with open(args.request, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        print(f"error: cannot read request: {exc}", file=sys.stderr)
        return EXIT_PARAM
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON: {exc}", file=sys.stderr)
        return EXIT_PARAM
    try:
        request = validate_request(data)
    except RequestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PARAM
    system = System(args.dir)
    if system.exists():
        existing = system.load_request()
        if existing["idemkey"] == request["idemkey"]:
            # Idempotent replay of the same request: no state change.
            print(json.dumps(system.snapshot(), sort_keys=True))
            return STATUS_EXIT[system.status()]
        print("error: a different idemkey already exists in this directory",
              file=sys.stderr)
        return EXIT_PARAM
    system.create(request)
    print(json.dumps(system.snapshot(), sort_keys=True))
    return EXIT_OK


def cmd_run(args):
    system = _require_system(args.dir)
    execute(system)
    print(json.dumps(system.snapshot(), sort_keys=True))
    return STATUS_EXIT[system.status()]


def cmd_crash(args):
    system = _require_system(args.dir)
    execute(system, crash_at=args.at)
    print(json.dumps(system.snapshot(), sort_keys=True))
    return STATUS_EXIT[system.status()]


def cmd_recover(args):
    system = _require_system(args.dir)
    execute(system)
    print(json.dumps(system.snapshot(), sort_keys=True))
    return STATUS_EXIT[system.status()]


def cmd_state(args):
    system = _require_system(args.dir)
    print(json.dumps(system.snapshot(), sort_keys=True))
    return STATUS_EXIT[system.status()]


def main(argv=None):
    args = build_parser().parse_args(argv)
    handler = {
        "new": cmd_new,
        "run": cmd_run,
        "crash": cmd_crash,
        "recover": cmd_recover,
        "state": cmd_state,
    }[args.command]
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
