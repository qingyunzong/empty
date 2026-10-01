#!/usr/bin/env python3
"""Last-Writer-Wins register with tombstones.

Semantics:
- Records are ordered by (ts, node) lexicographically; identical (ts, node)
  is considered the same write (idempotent).
- delete creates a tombstone record; a tombstone beats concurrent puts with
  an older (ts, node) and loses to newer ones -- the same comparison rule.
- merge is commutative, associative and idempotent (per-key max).
- gc(before=T) collects tombstones with ts < T only if every live replica's
  watermark has passed the tombstone's ts; otherwise GC_UNSAFE and the state
  is left untouched.
- save() writes a single file atomically: temp file + fsync, then rename.
  A crash injected after the temp write and before the rename (env
  LWW_CRASH_POINT=before_rename) leaves either the old or the new file
  fully intact, never a half-written one. The file carries a SHA-256
  checksum verified on load.

CLI: reads JSON lines on stdin, writes JSON lines on stdout.
Any error prints {"ok": false, "error": CODE} and exits with status 3.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys


class RegisterError(Exception):
    code = "ERROR"


class BadInput(RegisterError):
    code = "BAD_INPUT"


class ValueTooLarge(RegisterError):
    code = "VALUE_TOO_LARGE"


class KeyspaceFull(RegisterError):
    code = "KEYSPACE_FULL"


class GcUnsafe(RegisterError):
    code = "GC_UNSAFE"


class ChecksumMismatch(RegisterError):
    code = "CHECKSUM_MISMATCH"


class IoError(RegisterError):
    code = "IO_ERROR"


def _order_key(rec):
    return (rec["ts"], rec["node"])


class LWWRegister:
    MAX_KEYS = 1000
    MAX_VALUE_BYTES = 64

    def __init__(self, node):
        if not isinstance(node, str) or not node:
            raise BadInput("node id must be a non-empty string")
        self.node = node
        self.clock = 0
        # key -> {"ts": int, "node": str, "value": str|None, "tomb": bool}
        self.entries = {}
        # node id -> highest logical timestamp that node is known to have seen
        self.watermarks = {node: 0}

    # -- local operations -------------------------------------------------

    def _tick(self):
        self.clock += 1
        self.watermarks[self.node] = self.clock
        return self.clock

    def _check_keyspace(self, key):
        if key not in self.entries and len(self.entries) >= self.MAX_KEYS:
            raise KeyspaceFull(
                "keyspace limit %d exceeded" % self.MAX_KEYS)

    def _apply(self, key, rec):
        cur = self.entries.get(key)
        if cur is None:
            self._check_keyspace(key)
            self.entries[key] = dict(rec)
        elif _order_key(rec) > _order_key(cur):
            self.entries[key] = dict(rec)
        # equal (ts, node): same write, keep existing (idempotent)

    def put(self, key, value):
        self._validate_key(key)
        self._validate_value(value)
        ts = self._tick()
        self._apply(key, {"ts": ts, "node": self.node,
                          "value": value, "tomb": False})

    def delete(self, key):
        self._validate_key(key)
        ts = self._tick()
        self._apply(key, {"ts": ts, "node": self.node,
                          "value": None, "tomb": True})

    def get(self, key):
        self._validate_key(key)
        rec = self.entries.get(key)
        if rec is None or rec["tomb"]:
            return None
        return rec["value"]

    # -- merge ------------------------------------------------------------

    def merge(self, state):
        other = self._validate_state(state)
        max_ts = self.clock
        for key, rec in other["entries"].items():
            self._apply(key, rec)
            if rec["ts"] > max_ts:
                max_ts = rec["ts"]
        for node, wm in other["watermarks"].items():
            if wm > self.watermarks.get(node, 0):
                self.watermarks[node] = wm
        # our knowledge has advanced at least to the highest ts we merged
        if max_ts > self.clock:
            self.clock = max_ts
        if self.clock > self.watermarks.get(self.node, 0):
            self.watermarks[self.node] = self.clock

    # -- garbage collection -------------------------------------------------

    def gc(self, before):
        if not isinstance(before, int) or isinstance(before, bool):
            raise BadInput("gc 'before' must be an integer")
        victims = {k: r for k, r in self.entries.items()
                   if r["tomb"] and r["ts"] < before}
        # Safety: every live replica must have seen each victim tombstone.
        # A replica is known to have seen it once its watermark >= ts.
        for key, rec in victims.items():
            for node, wm in self.watermarks.items():
                if wm < rec["ts"]:
                    raise GcUnsafe(
                        "tombstone %r (ts=%d) not seen by replica %r "
                        "(watermark=%d)" % (key, rec["ts"], node, wm))
        for key in victims:
            del self.entries[key]
        return len(victims)

    # -- serialization ------------------------------------------------------

    def to_dict(self):
        return {
            "node": self.node,
            "clock": self.clock,
            "entries": {k: dict(v) for k, v in self.entries.items()},
            "watermarks": dict(self.watermarks),
        }

    @classmethod
    def from_dict(cls, state):
        state = cls._validate_state(state)
        reg = cls(state["node"])
        reg.clock = state["clock"]
        reg.entries = {k: dict(v) for k, v in state["entries"].items()}
        reg.watermarks = dict(state["watermarks"])
        return reg

    @classmethod
    def _validate_state(cls, state):
        if not isinstance(state, dict):
            raise BadInput("state must be an object")
        node = state.get("node")
        clock = state.get("clock")
        entries = state.get("entries")
        watermarks = state.get("watermarks")
        if not isinstance(node, str) or not node:
            raise BadInput("state.node must be a non-empty string")
        if not isinstance(clock, int) or isinstance(clock, bool) or clock < 0:
            raise BadInput("state.clock must be a non-negative integer")
        if not isinstance(entries, dict):
            raise BadInput("state.entries must be an object")
        if not isinstance(watermarks, dict):
            raise BadInput("state.watermarks must be an object")
        for key, rec in entries.items():
            cls._validate_key(key)
            if not isinstance(rec, dict):
                raise BadInput("entry %r must be an object" % key)
            ts = rec.get("ts")
            rnode = rec.get("node")
            tomb = rec.get("tomb")
            value = rec.get("value")
            if not isinstance(ts, int) or isinstance(ts, bool) or ts < 0:
                raise BadInput("entry %r has bad ts" % key)
            if not isinstance(rnode, str) or not rnode:
                raise BadInput("entry %r has bad node" % key)
            if not isinstance(tomb, bool):
                raise BadInput("entry %r has bad tomb flag" % key)
            if tomb:
                if value is not None:
                    raise BadInput("tombstone %r must have null value" % key)
            else:
                cls._validate_value(value)
        for wnode, wm in watermarks.items():
            if not isinstance(wnode, str) or not wnode:
                raise BadInput("bad watermark node id")
            if not isinstance(wm, int) or isinstance(wm, bool) or wm < 0:
                raise BadInput("bad watermark for %r" % wnode)
        return state

    # -- persistence --------------------------------------------------------

    def save(self, path):
        payload = json.dumps(self.to_dict(), sort_keys=True,
                             separators=(",", ":"))
        envelope = json.dumps({
            "checksum": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
            "payload": self.to_dict(),
        }, sort_keys=True)
        directory = os.path.dirname(os.path.abspath(path))
        tmp_path = os.path.join(directory,
                                ".%s.tmp.%d" % (os.path.basename(path),
                                                os.getpid()))
        try:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                fh.write(envelope)
                fh.flush()
                os.fsync(fh.fileno())
            # Fault-injection point: crash after the temp file is fully
            # written and fsynced, but before the atomic rename.
            if os.environ.get("LWW_CRASH_POINT") == "before_rename":
                os._exit(2)
            os.replace(tmp_path, path)
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except RegisterError:
            raise
        except OSError as exc:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise IoError("save failed: %s" % exc)

    @classmethod
    def load(cls, path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError as exc:
            raise IoError("load failed: %s" % exc)
        try:
            envelope = json.loads(raw)
        except ValueError:
            raise ChecksumMismatch("file is not valid JSON")
        if not isinstance(envelope, dict) or \
                "checksum" not in envelope or "payload" not in envelope:
            raise ChecksumMismatch("file envelope is malformed")
        payload = json.dumps(envelope["payload"], sort_keys=True,
                             separators=(",", ":"))
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        if digest != envelope["checksum"]:
            raise ChecksumMismatch("checksum mismatch")
        return cls.from_dict(envelope["payload"])

    # -- validation helpers -------------------------------------------------

    @staticmethod
    def _validate_key(key):
        if not isinstance(key, str) or not key:
            raise BadInput("key must be a non-empty string")

    @classmethod
    def _validate_value(cls, value):
        if not isinstance(value, str):
            raise BadInput("value must be a string")
        if len(value.encode("utf-8")) > cls.MAX_VALUE_BYTES:
            raise ValueTooLarge(
                "value exceeds %d bytes" % cls.MAX_VALUE_BYTES)


# -- CLI --------------------------------------------------------------------


def _handle(register, file_path, request):
    op = request.get("op")
    if op == "put":
        register.put(request.get("key"), request.get("value"))
        return {"ok": True}
    if op == "get":
        return {"ok": True, "value": register.get(request.get("key"))}
    if op == "del":
        register.delete(request.get("key"))
        return {"ok": True}
    if op == "merge":
        register.merge(request.get("state"))
        return {"ok": True}
    if op == "gc":
        collected = register.gc(request.get("before"))
        return {"ok": True, "collected": collected}
    if op == "save":
        if not file_path:
            raise BadInput("save requires --file")
        register.save(file_path)
        return {"ok": True}
    if op == "load":
        if not file_path:
            raise BadInput("load requires --file")
        fresh = LWWRegister.load(file_path)
        register.node = fresh.node
        register.clock = fresh.clock
        register.entries = fresh.entries
        register.watermarks = fresh.watermarks
        return {"ok": True}
    if op == "dump":
        return {"ok": True, "state": register.to_dict()}
    raise BadInput("unknown op %r" % (op,))


def main(argv=None):
    parser = argparse.ArgumentParser(description="LWW register with tombstones")
    parser.add_argument("--node", default="node1", help="this node's id")
    parser.add_argument("--file", default=None, help="state file for save/load")
    args = parser.parse_args(argv)

    try:
        register = LWWRegister(args.node)
    except RegisterError as exc:
        print(json.dumps({"ok": False, "error": exc.code}))
        return 3

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise BadInput("request must be a JSON object")
            response = _handle(register, args.file, request)
        except RegisterError as exc:
            print(json.dumps({"ok": False, "error": exc.code,
                              "detail": str(exc)}))
            return 3
        except (ValueError, TypeError) as exc:
            print(json.dumps({"ok": False, "error": BadInput.code,
                              "detail": str(exc)}))
            return 3
        print(json.dumps(response))
    return 0


if __name__ == "__main__":
    sys.exit(main())
