#!/usr/bin/env python3
"""Persistent lease for a single resource with monotonic fence tokens and an op log.

States: FREE -> HELD -> (CANCELED | RELEASED). State and the append-only
operation log are persisted under a state directory (``--dir`` or ``$LEASE_DIR``),
so a crashed process can be reconciled with the ``recover`` command.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from enum import Enum
from pathlib import Path

EXIT_OK = 0
EXIT_NOT_HELD = 7
EXIT_CANCELED = 8
EXIT_STALE_TOKEN = 9

DEFAULT_TTL_SECONDS = 30.0
CRASH_POINTS = ("acquire", "write", "release")


class State(str, Enum):
    FREE = "FREE"
    HELD = "HELD"
    CANCELED = "CANCELED"
    RELEASED = "RELEASED"


def _ttl() -> float:
    return float(os.environ.get("LEASE_TTL_SECONDS", DEFAULT_TTL_SECONDS))


def _initial_state() -> dict:
    return {
        "state": State.FREE.value,
        "token": 0,          # current fence token (monotonic, never reused)
        "owner": None,       # KEY of the current lease holder
        "expiry": None,      # lease expiry as epoch seconds
        "applied": {},       # opid -> value (effects of the current reservation)
        "order": [],         # opids in apply order, for reverse-order release
        "crashed": False,
        "crash_point": None,
    }


class LeaseStore:
    """JSON state file + append-only JSONL operation log."""

    def __init__(self, directory: str | Path):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.dir / "lease_state.json"
        self.log_path = self.dir / "lease_ops.log"

    def load(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text())
        return _initial_state()

    def save(self, state: dict) -> None:
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
        os.replace(tmp, self.state_path)

    def log(self, event: dict) -> None:
        event = dict(event)
        event.setdefault("ts", time.time())
        with self.log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, sort_keys=True) + "\n")

    def read_log(self) -> list[dict]:
        if not self.log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]


def _lease_valid(st: dict, now: float) -> bool:
    return (
        st["state"] == State.HELD.value
        and st["expiry"] is not None
        and now < st["expiry"]
    )


def cmd_acquire(store: LeaseStore, key: str) -> int:
    now = time.time()
    st = store.load()
    if _lease_valid(st, now) and st["owner"] == key:
        # Same KEY re-acquires while the lease is valid: same token, deduped.
        store.log({"event": "acquire", "key": key, "token": st["token"],
                   "expiry": st["expiry"], "dedup": True})
        print(st["token"])
        return EXIT_OK
    # New owner (or expired lease): strictly larger fence token, fresh effects.
    st["token"] += 1
    st["state"] = State.HELD.value
    st["owner"] = key
    st["expiry"] = now + _ttl()
    st["applied"] = {}
    st["order"] = []
    store.save(st)
    store.log({"event": "acquire", "key": key, "token": st["token"],
               "expiry": st["expiry"], "dedup": False})
    print(st["token"])
    return EXIT_OK


def cmd_write(store: LeaseStore, token: int, opid: str, value: str) -> int:
    st = store.load()
    if st["state"] == State.CANCELED.value:
        print("write rejected: lease is CANCELED", file=sys.stderr)
        return EXIT_CANCELED
    if st["state"] != State.HELD.value:
        print(f"write rejected: no active lease (state={st['state']})",
              file=sys.stderr)
        return EXIT_NOT_HELD
    if not _lease_valid(st, time.time()):
        print("write rejected: lease expired", file=sys.stderr)
        return EXIT_NOT_HELD
    if token != st["token"]:
        print(f"stale token: {token} != current {st['token']}", file=sys.stderr)
        return EXIT_STALE_TOKEN
    if opid in st["applied"]:
        # Idempotent: same TOKEN+OPID already applied, no duplicate effect.
        print(f"duplicate opid={opid} (idempotent, no-op)")
        return EXIT_OK
    st["applied"][opid] = value
    st["order"].append(opid)
    store.save(st)
    store.log({"event": "write", "token": token, "opid": opid, "value": value})
    print(f"ok opid={opid}")
    return EXIT_OK


def cmd_cancel(store: LeaseStore) -> int:
    st = store.load()
    if st["state"] != State.HELD.value:
        print(f"cancel rejected: state={st['state']}", file=sys.stderr)
        return EXIT_NOT_HELD
    st["state"] = State.CANCELED.value
    store.save(st)
    store.log({"event": "cancel"})
    # Checkpoint where the holder can observe the cancellation.
    print(State.CANCELED.value)
    return EXIT_OK


def cmd_renew(store: LeaseStore) -> int:
    st = store.load()
    if not _lease_valid(st, time.time()):
        print(f"renew rejected: state={st['state']}", file=sys.stderr)
        return EXIT_NOT_HELD
    st["expiry"] = time.time() + _ttl()
    store.save(st)
    store.log({"event": "renew", "expiry": st["expiry"]})
    print(f"renewed until {st['expiry']:.3f}")
    return EXIT_OK


def cmd_release(store: LeaseStore) -> int:
    st = store.load()
    if st["state"] != State.HELD.value:
        print(f"release rejected: state={st['state']}", file=sys.stderr)
        return EXIT_NOT_HELD
    # Undo this reservation's effects in reverse order.
    undone = []
    for opid in reversed(st["order"]):
        value = st["applied"].pop(opid)
        undone.append(opid)
        store.log({"event": "release-effect", "opid": opid, "value": value})
    st["order"] = []
    st["state"] = State.RELEASED.value
    st["owner"] = None
    st["expiry"] = None
    store.save(st)
    store.log({"event": "release", "undone": undone})
    print("released" + (" effects=" + ",".join(undone) if undone else ""))
    return EXIT_OK


def cmd_crash(store: LeaseStore, point: str) -> int:
    st = store.load()
    st["crashed"] = True
    st["crash_point"] = point
    store.save(st)
    store.log({"event": "crash", "at": point})
    print(f"crashed after {point} event")
    return EXIT_OK


def cmd_recover(store: LeaseStore) -> int:
    """Rebuild state by replaying the op log, deduping by KEY and OPID."""
    st = _initial_state()
    for ev in store.read_log():
        kind = ev["event"]
        if kind == "acquire":
            if (st["state"] == State.HELD.value
                    and st["owner"] == ev["key"]
                    and st["expiry"] is not None
                    and ev["ts"] < st["expiry"]):
                continue  # dedup: same KEY re-acquire within a valid lease
            st["token"] = ev["token"]
            st["state"] = State.HELD.value
            st["owner"] = ev["key"]
            st["expiry"] = ev["expiry"]
            st["applied"] = {}
            st["order"] = []
        elif kind == "write":
            if ev["opid"] in st["applied"]:
                continue  # dedup: same OPID applied at most once
            st["applied"][ev["opid"]] = ev["value"]
            st["order"].append(ev["opid"])
        elif kind == "release-effect":
            st["applied"].pop(ev["opid"], None)
            if ev["opid"] in st["order"]:
                st["order"].remove(ev["opid"])
        elif kind == "release":
            st["state"] = State.RELEASED.value
            st["owner"] = None
            st["expiry"] = None
        elif kind == "cancel":
            st["state"] = State.CANCELED.value
        elif kind == "renew":
            st["expiry"] = ev["expiry"]
        elif kind == "crash":
            pass  # crash marker only; replay continues past it
    st["crashed"] = False
    st["crash_point"] = None
    store.save(st)
    store.log({"event": "recover"})
    print(json.dumps(st, sort_keys=True))
    return EXIT_OK


def cmd_state(store: LeaseStore) -> int:
    st = store.load()
    st["lease_valid"] = _lease_valid(st, time.time())
    print(json.dumps(st, indent=2, sort_keys=True))
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lease", description=__doc__)
    parser.add_argument("--dir", default=os.environ.get("LEASE_DIR", ".lease"),
                        help="state directory (default: $LEASE_DIR or .lease)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("acquire", help="acquire the lease for KEY")
    p.add_argument("key")
    p = sub.add_parser("write", help="write VALUE under OPID fenced by TOKEN")
    p.add_argument("token", type=int)
    p.add_argument("opid")
    p.add_argument("value")
    sub.add_parser("cancel", help="cancel the current lease")
    sub.add_parser("renew", help="extend the current lease")
    sub.add_parser("release", help="release, undoing effects in reverse order")
    p = sub.add_parser("crash", help="simulate a crash after an event")
    p.add_argument("--at", required=True, choices=CRASH_POINTS)
    sub.add_parser("recover", help="replay the op log, deduping KEY/OPID")
    sub.add_parser("state", help="print current state as JSON")

    args = parser.parse_args(argv)
    store = LeaseStore(args.dir)
    if args.cmd == "acquire":
        return cmd_acquire(store, args.key)
    if args.cmd == "write":
        return cmd_write(store, args.token, args.opid, args.value)
    if args.cmd == "cancel":
        return cmd_cancel(store)
    if args.cmd == "renew":
        return cmd_renew(store)
    if args.cmd == "release":
        return cmd_release(store)
    if args.cmd == "crash":
        return cmd_crash(store, args.at)
    if args.cmd == "recover":
        return cmd_recover(store)
    if args.cmd == "state":
        return cmd_state(store)
    return 2


if __name__ == "__main__":
    sys.exit(main())
