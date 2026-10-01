"""LWW (last-write-wins) register set with tombstones.

Semantics:
- Entries are ordered by (ts, node) lexicographically; a full tie is the
  same write (resolved deterministically by payload so merge stays
  commutative/associative/idempotent).
- del creates a tombstone; a tombstone concurrent with an older put wins,
  a newer put wins by the same comparison.
- gc_before=T only collects tombstones with ts < T that every live replica
  has seen; otherwise GC_UNSAFE and the state is unchanged.
- save writes a single file atomically (tmp file + fsync + rename); a crash
  after the tmp write and before the rename leaves either the old or the
  new file fully intact, verified by a SHA-256 checksum.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

MAX_KEYS = 1000
MAX_VALUE_BYTES = 64


class LWWError(Exception):
    def __init__(self, code, msg=""):
        super().__init__(msg or code)
        self.code = code


def _check_key(key):
    if isinstance(key, bool) or not isinstance(key, (int, str)):
        raise LWWError("BAD_KEY", "key must be int or str")
    if isinstance(key, str) and not key:
        raise LWWError("BAD_KEY", "key must be non-empty")
    return key


def _check_ts(ts):
    if isinstance(ts, bool) or not isinstance(ts, int) or ts < 0:
        raise LWWError("BAD_TS", "ts must be a non-negative integer")
    return ts


def _check_node(node):
    if not isinstance(node, str) or not node:
        raise LWWError("BAD_NODE", "node must be a non-empty string")
    return node


def _check_value(value):
    if not isinstance(value, str):
        raise LWWError("BAD_VALUE", "value must be a string")
    if len(value.encode("utf-8")) > MAX_VALUE_BYTES:
        raise LWWError("VALUE_TOO_LARGE", "value exceeds 64 bytes")
    return value


def _order(entry):
    return (entry["ts"], entry["node"])


def _payload_order(entry):
    return (entry["tombstone"], "" if entry["value"] is None else entry["value"])


def _winner(a, b):
    """Deterministic winner between two entries for the same key."""
    oa, ob = _order(a), _order(b)
    if oa != ob:
        return a if oa > ob else b
    # Full (ts, node) tie: the same write. If payloads still differ, break
    # the tie deterministically so merge stays commutative/associative.
    pa, pb = _payload_order(a), _payload_order(b)
    return a if pa >= pb else b


def _entry(key, value, ts, node, tombstone, seen_by=None):
    return {
        "key": key,
        "value": value,
        "ts": ts,
        "node": node,
        "tombstone": tombstone,
        "seen_by": sorted(seen_by) if seen_by else [],
    }


class Store:
    def __init__(self, node):
        self.node = _check_node(node)
        self.entries = {}
        self.live = {self.node}

    # -- mutations ---------------------------------------------------------

    def put(self, key, value, ts, node=None):
        key = _check_key(key)
        value = _check_value(value)
        ts = _check_ts(ts)
        node = _check_node(node) if node is not None else self.node
        self.live.add(node)
        cand = _entry(key, value, ts, node, False)
        cur = self.entries.get(key)
        if cur is None:
            if len(self.entries) >= MAX_KEYS:
                raise LWWError("KEYSPACE_FULL", "key space exceeds 1000")
            self.entries[key] = cand
        else:
            self.entries[key] = _winner(cur, cand)

    def delete(self, key, ts, node=None):
        key = _check_key(key)
        ts = _check_ts(ts)
        node = _check_node(node) if node is not None else self.node
        self.live.add(node)
        cand = _entry(key, None, ts, node, True, seen_by={self.node})
        cur = self.entries.get(key)
        if cur is None:
            if len(self.entries) >= MAX_KEYS:
                raise LWWError("KEYSPACE_FULL", "key space exceeds 1000")
            self.entries[key] = cand
        else:
            win = _winner(cur, cand)
            if win is cand and cur["tombstone"] and _order(cur) == _order(cand):
                win = dict(cand)
                win["seen_by"] = sorted(set(cur["seen_by"]) | set(cand["seen_by"]))
            self.entries[key] = win

    def get(self, key):
        key = _check_key(key)
        ent = self.entries.get(key)
        if ent is None or ent["tombstone"]:
            return None
        return ent["value"]

    # -- merge ---------------------------------------------------------------

    def merge(self, other):
        """Merge another Store (or its to_dict() state)."""
        state = other.to_dict() if isinstance(other, Store) else other
        src_node = state.get("node")
        incoming = [_entry(e["key"], e["value"], e["ts"], e["node"],
                           e["tombstone"], e.get("seen_by"))
                    for e in state["entries"]]
        new_keys = {e["key"] for e in incoming} - set(self.entries)
        if len(self.entries) + len(new_keys) > MAX_KEYS:
            raise LWWError("KEYSPACE_FULL", "key space exceeds 1000")

        self.live.add(self.node)
        if src_node:
            self.live.add(src_node)
        self.live |= set(state.get("live", []))

        for inc in incoming:
            if inc["tombstone"]:
                # This store (and certainly the source replica) has now seen
                # this tombstone.
                seen = set(inc["seen_by"]) | {self.node}
                if src_node:
                    seen.add(src_node)
                inc["seen_by"] = sorted(seen)
            cur = self.entries.get(inc["key"])
            if cur is None:
                self.entries[inc["key"]] = inc
                continue
            win = _winner(cur, inc)
            if win["tombstone"] and cur["tombstone"] and inc["tombstone"]:
                win = dict(win)
                win["seen_by"] = sorted(set(cur["seen_by"]) | set(inc["seen_by"]))
            self.entries[inc["key"]] = win

    # -- garbage collection --------------------------------------------------

    def gc(self, before):
        before = _check_ts(before)
        unsafe = [
            e for e in self.entries.values()
            if e["tombstone"] and e["ts"] < before
            and not self.live <= set(e["seen_by"])
        ]
        if unsafe:
            raise LWWError("GC_UNSAFE",
                           "tombstone not yet seen by all live replicas")
        doomed = [k for k, e in self.entries.items()
                  if e["tombstone"] and e["ts"] < before]
        for k in doomed:
            del self.entries[k]
        return len(doomed)

    # -- serialization -------------------------------------------------------

    def to_dict(self):
        entries = sorted(
            (dict(e) for e in self.entries.values()),
            key=lambda e: json.dumps(e["key"], sort_keys=True),
        )
        for e in entries:
            e["seen_by"] = sorted(e["seen_by"])
        return {
            "node": self.node,
            "live": sorted(self.live),
            "entries": entries,
        }

    @classmethod
    def from_dict(cls, state):
        store = cls(state["node"])
        store.live = set(state.get("live", [])) | {store.node}
        for e in state["entries"]:
            store.entries[e["key"]] = _entry(
                e["key"], e["value"], e["ts"], e["node"],
                e["tombstone"], e.get("seen_by"))
        return store

    # -- persistence -----------------------------------------------------------

    def save(self, path):
        payload = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))
        checksum = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        blob = json.dumps({"payload": self.to_dict(), "checksum": checksum},
                          sort_keys=True)
        directory = os.path.dirname(os.path.abspath(path))
        tmp = os.path.join(directory, ".%s.tmp.%d" % (os.path.basename(path),
                                                      os.getpid()))
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        # Fault-injection point: crash after the tmp file is fully written
        # and fsynced, but before the atomic rename.
        if os.environ.get("LWW_CRASH_BEFORE_RENAME"):
            os._exit(2)
        os.replace(tmp, path)
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)

    @classmethod
    def load(cls, path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                blob = json.load(fh)
        except FileNotFoundError:
            raise LWWError("LOAD_FAILED", "no such file: %s" % path)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise LWWError("CHECKSUM_MISMATCH", "file is not valid JSON")
        try:
            payload = blob["payload"]
            checksum = blob["checksum"]
        except (TypeError, KeyError):
            raise LWWError("CHECKSUM_MISMATCH", "file structure invalid")
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != checksum:
            raise LWWError("CHECKSUM_MISMATCH", "checksum mismatch")
        return cls.from_dict(payload)


# -- CLI -----------------------------------------------------------------------


def _handle(store, cmd):
    op = cmd.get("op")
    if op == "put":
        store.put(cmd.get("key"), cmd.get("value"), cmd.get("ts"),
                  cmd.get("node"))
        return {"ok": True}
    if op == "get":
        key = _check_key(cmd.get("key"))
        ent = store.entries.get(key)
        resp = {"ok": True, "found": bool(ent and not ent["tombstone"])}
        if ent:
            resp.update({"value": ent["value"], "ts": ent["ts"],
                         "node": ent["node"], "tombstone": ent["tombstone"]})
        return resp
    if op == "del":
        store.delete(cmd.get("key"), cmd.get("ts"), cmd.get("node"))
        return {"ok": True}
    if op == "merge":
        state = cmd.get("state")
        if not isinstance(state, dict):
            raise LWWError("BAD_STATE", "merge requires a state object")
        store.merge(state)
        return {"ok": True}
    if op == "dump":
        return {"ok": True, "state": store.to_dict()}
    if op == "gc":
        return {"ok": True, "collected": store.gc(cmd.get("before"))}
    if op == "save":
        path = cmd.get("path")
        if not isinstance(path, str) or not path:
            raise LWWError("BAD_PATH", "save requires a path")
        store.save(path)
        return {"ok": True}
    if op == "load":
        path = cmd.get("path")
        if not isinstance(path, str) or not path:
            raise LWWError("BAD_PATH", "load requires a path")
        fresh = Store.load(path)
        store.node = fresh.node
        store.entries = fresh.entries
        store.live = fresh.live
        return {"ok": True}
    raise LWWError("BAD_OP", "unknown op: %r" % (op,))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    node = argv[0] if argv else os.environ.get("LWW_NODE", "node0")
    store = Store(node)
    had_error = False
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            if not isinstance(cmd, dict):
                raise LWWError("BAD_CMD", "command must be a JSON object")
            resp = _handle(store, cmd)
        except LWWError as exc:
            had_error = True
            resp = {"ok": False, "error": exc.code, "message": str(exc)}
        except Exception as exc:  # noqa: BLE001 - report, keep REPL alive
            had_error = True
            resp = {"ok": False, "error": "INTERNAL", "message": str(exc)}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 3 if had_error else 0


if __name__ == "__main__":
    sys.exit(main())
