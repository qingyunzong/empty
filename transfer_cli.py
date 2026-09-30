"""Idempotent two-account transfer CLI with append-only JSONL event log.

Commands: new, run, crash --at, recover, state.
Exit codes: 0 success/compensated, 2 in progress, 4 bad arguments, 10 permanent failure.
"""

import argparse
import json
import os
import sys

EXIT_OK = 0
EXIT_IN_PROGRESS = 2
EXIT_BAD_ARGS = 4
EXIT_FAILED = 10

STATUSES = ("PENDING", "PREPARED", "COMPLETED", "COMPENSATING", "COMPENSATED", "FAILED")
CRASH_POINTS = ("after_debit_event", "after_debit_action", "after_credit_action")

EVENTS_FILE = "events.jsonl"
LEDGER_FILE = "ledger.json"
CONFIG_FILE = "config.json"


class Crash(Exception):
    """Simulated process crash at a named crash point."""


class Store:
    """Append-only event log + idempotent ledger, all writes flush+fsync."""

    def __init__(self, workdir):
        self.workdir = workdir
        self.events_path = os.path.join(workdir, EVENTS_FILE)
        self.ledger_path = os.path.join(workdir, LEDGER_FILE)
        self.config_path = os.path.join(workdir, CONFIG_FILE)

    # --- low level IO -----------------------------------------------------
    def append_event(self, event):
        with open(self.events_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def read_events(self):
        if not os.path.exists(self.events_path):
            return []
        events = []
        with open(self.events_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    events.append(json.loads(line))
        return events

    def write_json_atomic(self, path, payload):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        dir_fd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    def read_json(self, path):
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    # --- domain state ------------------------------------------------------
    def load_config(self):
        return self.read_json(self.config_path)

    def current_status(self):
        status = "PENDING"
        for event in self.read_events():
            if event.get("type") == "status":
                status = event["status"]
        return status

    def set_status(self, status):
        assert status in STATUSES
        self.append_event({"type": "status", "status": status})

    def has_event(self, event_type):
        return any(e.get("type") == event_type for e in self.read_events())

    def load_ledger(self):
        return self.read_json(self.ledger_path)

    def apply(self, action, delta):
        """Idempotent ledger mutation keyed by idemkey:action. Returns True if applied now."""
        config = self.load_config()
        key = "%s:%s" % (config["transfer"]["idemkey"], action)
        ledger = self.load_ledger()
        if key in ledger["applied"]:
            return False
        account, amount = delta
        ledger["balances"][account] += amount
        ledger["applied"].append(key)
        self.write_json_atomic(self.ledger_path, ledger)
        return True


def validate_config(config):
    if not isinstance(config, dict):
        raise ValueError("config must be a JSON object")
    accounts = config.get("accounts")
    if not isinstance(accounts, dict) or len(accounts) != 2:
        raise ValueError("config.accounts must define exactly two accounts")
    for name, balance in accounts.items():
        if not isinstance(name, str) or not name:
            raise ValueError("account names must be non-empty strings")
        if not isinstance(balance, int) or isinstance(balance, bool) or balance < 0:
            raise ValueError("account balances must be non-negative integers")
    transfer = config.get("transfer")
    if not isinstance(transfer, dict):
        raise ValueError("config.transfer must be an object")
    idemkey = transfer.get("idemkey")
    if not isinstance(idemkey, str) or not idemkey:
        raise ValueError("transfer.idemkey must be a non-empty string")
    src, dst = transfer.get("from"), transfer.get("to")
    if src not in accounts or dst not in accounts or src == dst:
        raise ValueError("transfer.from/to must be the two distinct declared accounts")
    amount = transfer.get("amount")
    if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0:
        raise ValueError("transfer.amount must be a positive integer")
    if accounts[src] < amount:
        raise ValueError("insufficient funds in source account")
    for flag in ("fail_credit", "fail_compensation"):
        if not isinstance(transfer.get(flag, False), bool):
            raise ValueError("transfer.%s must be a boolean" % flag)


def cmd_new(store, config_path):
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print("error: invalid JSON config: %s" % exc, file=sys.stderr)
        return EXIT_BAD_ARGS
    try:
        validate_config(config)
    except ValueError as exc:
        print("error: invalid config: %s" % exc, file=sys.stderr)
        return EXIT_BAD_ARGS
    if os.path.exists(store.events_path):
        print("error: workspace already initialized", file=sys.stderr)
        return EXIT_BAD_ARGS
    os.makedirs(store.workdir, exist_ok=True)
    store.write_json_atomic(store.config_path, config)
    ledger = {"balances": dict(config["accounts"]), "applied": []}
    store.write_json_atomic(store.ledger_path, ledger)
    transfer = config["transfer"]
    store.append_event({
        "type": "created",
        "idemkey": transfer["idemkey"],
        "from": transfer["from"],
        "to": transfer["to"],
        "amount": transfer["amount"],
    })
    store.set_status("PENDING")
    print(json.dumps({"status": "PENDING", "idemkey": transfer["idemkey"]}, sort_keys=True))
    return EXIT_OK


def execute(store, crash_at=None):
    """Drive the transfer state machine. Returns final status.

    Replays any action lacking its success event; ledger applies are
    idempotent by idemkey so replay never double-mutates the ledger.
    """
    config = store.load_config()
    transfer = config["transfer"]
    src, dst, amount = transfer["from"], transfer["to"], transfer["amount"]

    status = store.current_status()
    if status in ("COMPLETED", "COMPENSATED", "FAILED"):
        return status  # idempotent replay of a finished request

    if status == "PENDING":
        store.set_status("PREPARED")
        store.append_event({"type": "debit_intent", "idemkey": transfer["idemkey"]})
        if crash_at == "after_debit_event":
            raise Crash(crash_at)

    if not store.has_event("debit_done"):
        store.apply("debit", (src, -amount))
        if crash_at == "after_debit_action":
            raise Crash(crash_at)
        store.append_event({"type": "debit_done", "idemkey": transfer["idemkey"], "amount": amount})

    if not store.has_event("credit_done"):
        store.append_event({"type": "credit_intent", "idemkey": transfer["idemkey"]})
        credit_ok = not transfer.get("fail_credit", False)
        if credit_ok:
            store.apply("credit", (dst, amount))
        if crash_at == "after_credit_action":
            raise Crash(crash_at)
        if credit_ok:
            store.append_event({"type": "credit_done", "idemkey": transfer["idemkey"], "amount": amount})
        else:
            store.append_event({"type": "credit_failed", "idemkey": transfer["idemkey"],
                                "reason": "permanent"})
            store.set_status("COMPENSATING")
            if not store.has_event("refund_done"):
                if transfer.get("fail_compensation", False):
                    store.append_event({"type": "refund_failed", "idemkey": transfer["idemkey"],
                                        "reason": "permanent"})
                    store.set_status("FAILED")
                    return "FAILED"
                store.apply("refund", (src, amount))
                store.append_event({"type": "refund_done", "idemkey": transfer["idemkey"], "amount": amount})
            store.set_status("COMPENSATED")
            return "COMPENSATED"

    store.set_status("COMPLETED")
    return "COMPLETED"


def exit_code_for(status):
    return {"COMPLETED": EXIT_OK, "COMPENSATED": EXIT_OK,
            "FAILED": EXIT_FAILED}.get(status, EXIT_IN_PROGRESS)


def cmd_run(store, crash_at=None):
    if not os.path.exists(store.events_path):
        print("error: workspace not initialized; run 'new' first", file=sys.stderr)
        return EXIT_BAD_ARGS
    try:
        status = execute(store, crash_at=crash_at)
    except Crash:
        status = store.current_status()
        print(json.dumps({"status": status, "crashed": True,
                          "balances": store.load_ledger()["balances"]}, sort_keys=True))
        return EXIT_IN_PROGRESS
    print(json.dumps({"status": status,
                      "balances": store.load_ledger()["balances"]}, sort_keys=True))
    return exit_code_for(status)


def cmd_state(store):
    if not os.path.exists(store.events_path):
        print("error: workspace not initialized; run 'new' first", file=sys.stderr)
        return EXIT_BAD_ARGS
    print(json.dumps({"status": store.current_status(),
                      "balances": store.load_ledger()["balances"]}, sort_keys=True))
    return EXIT_OK


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print("error: %s" % message, file=sys.stderr)
        sys.exit(EXIT_BAD_ARGS)


def main(argv=None):
    parser = Parser(prog="transfer_cli.py")
    parser.add_argument("--dir", default="workspace_data", help="workspace directory")
    sub = parser.add_subparsers(dest="command", required=True)
    p_new = sub.add_parser("new")
    p_new.add_argument("config", help="path to JSON config (accounts + transfer)")
    sub.add_parser("run")
    p_crash = sub.add_parser("crash")
    p_crash.add_argument("--at", required=True, choices=CRASH_POINTS)
    sub.add_parser("recover")
    sub.add_parser("state")
    args = parser.parse_args(argv)

    store = Store(args.dir)
    if args.command == "new":
        return cmd_new(store, args.config)
    if args.command == "run":
        return cmd_run(store)
    if args.command == "crash":
        return cmd_run(store, crash_at=args.at)
    if args.command == "recover":
        return cmd_run(store)
    if args.command == "state":
        return cmd_state(store)
    return EXIT_BAD_ARGS


if __name__ == "__main__":
    sys.exit(main())
