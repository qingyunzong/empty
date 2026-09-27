#!/usr/bin/env python3
"""Persistent single-resource lease with monotonic fencing tokens and an op log.

Commands: acquire KEY, write TOKEN OPID VALUE, cancel, renew, release,
crash --at POINT, recover, state.

States: FREE, HELD, CANCELED, RELEASED.

Exit codes:
  0  success
  1  general error
  9  stale fencing token (token != current token)
  10 lease canceled, writes rejected
  11 no active lease / lease held by another key
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from enum import Enum

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_STALE_TOKEN = 9
EXIT_CANCELED = 10
EXIT_NOT_HELD = 11

DEFAULT_DB_PATH = "lease_state.json"
DEFAULT_TTL_SECONDS = 30.0

CRASH_POINTS = {
    "after-acquire": "acquire",
    "after-write": "write",
    "after-release": "release",
}


class State(str, Enum):
    FREE = "FREE"
    HELD = "HELD"
    CANCELED = "CANCELED"
    RELEASED = "RELEASED"


def initial_snapshot():
    return {
        "state": State.FREE.value,
        "key": None,
        "token": 0,
        "max_token": 0,
        "expires_at": None,
        "effects": [],
        "op_log": [],
    }


class LeaseError(Exception):
    def __init__(self, message, code=EXIT_ERROR):
        super().__init__(message)
        self.code = code


class LeaseStore:
    """Event-sourced lease store persisted as a single JSON document."""

    def __init__(self, path, ttl=DEFAULT_TTL_SECONDS, clock=time.time):
        self.path = path
        self.ttl = ttl
        self.clock = clock
        self.events = []
        self.snapshot = initial_snapshot()
        self.crashed = False
        self._load()

    def _load(self):
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            self.events = data.get("events", [])
            self.snapshot = data.get("snapshot", initial_snapshot())
            self.crashed = data.get("crashed", False)

    def _save(self):
        data = {
            "events": self.events,
            "snapshot": self.snapshot,
            "crashed": self.crashed,
        }
        directory = os.path.dirname(os.path.abspath(self.path))
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".lease-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _require_live(self):
        if self.crashed:
            raise LeaseError("store is crashed; run `recover` first")

    def _record(self, event):
        event["ts"] = self.clock()
        self.events.append(event)
        self._apply_event(event)
        self._save()

    def _apply_event(self, ev):
        getattr(self, "_apply_" + ev["event"])(ev)

    def _apply_acquire(self, ev):
        snap = self.snapshot
        if (
            snap["state"] == State.HELD.value
            and snap["key"] == ev["key"]
            and snap["expires_at"] is not None
            and snap["expires_at"] > ev["ts"]
        ):
            return  # duplicate acquire for same key while lease valid: keep token
        snap["state"] = State.HELD.value
        snap["key"] = ev["key"]
        snap["token"] = ev["token"]
        snap["max_token"] = max(snap["max_token"], ev["token"])
        snap["expires_at"] = ev["expires_at"]
        snap["effects"] = []

    def _apply_write(self, ev):
        snap = self.snapshot
        for entry in snap["op_log"]:
            if (
                entry["op"] == "write"
                and entry["token"] == ev["token"]
                and entry["opid"] == ev["opid"]
            ):
                return  # same TOKEN+OPID already applied: idempotent
        effect = {"token": ev["token"], "opid": ev["opid"], "value": ev["value"]}
        snap["effects"].append(effect)
        snap["op_log"].append({"op": "write", **effect})

    def _apply_cancel(self, ev):
        self.snapshot["state"] = State.CANCELED.value

    def _apply_renew(self, ev):
        self.snapshot["expires_at"] = ev["expires_at"]

    def _apply_release(self, ev):
        snap = self.snapshot
        for eff in ev["undone"]:
            snap["op_log"].append(
                {
                    "op": "undo",
                    "token": eff["token"],
                    "opid": eff["opid"],
                    "value": eff["value"],
                }
            )
        snap["effects"] = []
        snap["state"] = State.RELEASED.value
        snap["expires_at"] = None

    def acquire(self, key):
        self._require_live()
        now = self.clock()
        snap = self.snapshot
        valid = snap["expires_at"] is not None and snap["expires_at"] > now
        if snap["state"] == State.HELD.value and valid:
            if snap["key"] == key:
                return snap["token"], False
            raise LeaseError(
                f"lease held by key {snap['key']!r}", EXIT_NOT_HELD
            )
        event = {
            "event": "acquire",
            "key": key,
            "token": snap["max_token"] + 1,
            "expires_at": now + self.ttl,
        }
        self._record(event)
        return event["token"], True

    def write(self, token, opid, value):
        self._require_live()
        snap = self.snapshot
        if snap["state"] == State.CANCELED.value:
            raise LeaseError("lease canceled; writes rejected", EXIT_CANCELED)
        if snap["state"] != State.HELD.value:
            raise LeaseError(
                f"no active lease (state={snap['state']})", EXIT_NOT_HELD
            )
        if token != snap["token"]:
            raise LeaseError(
                f"stale token {token}; current token is {snap['token']}",
                EXIT_STALE_TOKEN,
            )
        for entry in snap["op_log"]:
            if (
                entry["op"] == "write"
                and entry["token"] == token
                and entry["opid"] == opid
            ):
                return False  # duplicate write: idempotent success
        self._record(
            {"event": "write", "token": token, "opid": opid, "value": value}
        )
        return True

    def cancel(self):
        self._require_live()
        if self.snapshot["state"] != State.HELD.value:
            raise LeaseError(
                f"cannot cancel: state={self.snapshot['state']}", EXIT_NOT_HELD
            )
        self._record({"event": "cancel"})

    def renew(self):
        self._require_live()
        if self.snapshot["state"] != State.HELD.value:
            raise LeaseError(
                f"cannot renew: state={self.snapshot['state']}", EXIT_NOT_HELD
            )
        expires_at = self.clock() + self.ttl
        self._record({"event": "renew", "expires_at": expires_at})
        return expires_at

    def release(self):
        self._require_live()
        snap = self.snapshot
        if snap["state"] != State.HELD.value:
            raise LeaseError(
                f"cannot release: state={snap['state']}", EXIT_NOT_HELD
            )
        undone = [dict(eff) for eff in reversed(snap["effects"])]
        self._record({"event": "release", "undone": undone})
        return [eff["opid"] for eff in undone]

    def crash(self, point):
        self._require_live()
        target = CRASH_POINTS[point]
        index = None
        for i in range(len(self.events) - 1, -1, -1):
            if self.events[i]["event"] == target:
                index = i
                break
        if index is None:
            raise LeaseError(f"no {target} event to crash after")
        lost = self.events[index + 1 :]
        self.events = self.events[: index + 1]
        self.crashed = True
        self._save()
        return lost

    def recover(self):
        self.snapshot = initial_snapshot()
        for ev in self.events:
            self._apply_event(ev)
        self.crashed = False
        self._save()
        return self.snapshot

    def state(self):
        snap = self.snapshot
        return {
            "state": snap["state"],
            "key": snap["key"],
            "token": snap["token"],
            "max_token": snap["max_token"],
            "expires_at": snap["expires_at"],
            "crashed": self.crashed,
            "effects": list(snap["effects"]),
            "op_log": list(snap["op_log"]),
        }


def build_parser():
    parser = argparse.ArgumentParser(
        prog="lease",
        description="Persistent single-resource lease with fencing tokens.",
    )
    parser.add_argument(
        "--db", default=os.environ.get("LEASE_DB", DEFAULT_DB_PATH),
        help="path to the persistent state file",
    )
    parser.add_argument(
        "--ttl", type=float,
        default=float(os.environ.get("LEASE_TTL_SECONDS", DEFAULT_TTL_SECONDS)),
        help="lease time-to-live in seconds",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("acquire", help="acquire the lease for KEY")
    p.add_argument("key")

    p = sub.add_parser("write", help="write VALUE fenced by TOKEN, idempotent by OPID")
    p.add_argument("token", type=int)
    p.add_argument("opid")
    p.add_argument("value")

    sub.add_parser("cancel", help="cancel the current lease")
    sub.add_parser("renew", help="extend the current lease")
    sub.add_parser("release", help="release, undoing this lease's effects in reverse")

    p = sub.add_parser("crash", help="simulate a crash at an event boundary")
    p.add_argument("--at", required=True, choices=sorted(CRASH_POINTS))

    sub.add_parser("recover", help="rebuild state from the event log")
    sub.add_parser("state", help="print current state as JSON")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    store = LeaseStore(args.db, ttl=args.ttl)
    try:
        if args.command == "acquire":
            token, _created = store.acquire(args.key)
            print(token)
        elif args.command == "write":
            applied = store.write(args.token, args.opid, args.value)
            print("ok" if applied else "ok (duplicate, idempotent)")
        elif args.command == "cancel":
            store.cancel()
            print("canceled")
        elif args.command == "renew":
            print(f"renewed until {store.renew():.6f}")
        elif args.command == "release":
            undone = store.release()
            suffix = f" (undone: {', '.join(undone)})" if undone else ""
            print(f"released{suffix}")
        elif args.command == "crash":
            lost = store.crash(args.at)
            print(f"crashed at {args.at} ({len(lost)} event(s) lost)")
        elif args.command == "recover":
            snap = store.recover()
            print(f"recovered: state={snap['state']} token={snap['token']}")
        elif args.command == "state":
            print(json.dumps(store.state(), indent=2))
    except LeaseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.code
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
