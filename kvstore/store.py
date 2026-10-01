"""Single-file append-only log store with nested transactions (max depth 3).

Log format: one JSON object per line.
    {"op": "begin", "txn": 1}
    {"op": "put", "txn": 1, "key": "a", "value": 1}
    {"op": "del", "txn": 1, "key": "a"}
    {"op": "commit", "txn": 1}
    {"op": "rollback", "txn": 1}

Durability model: only records of a transaction whose outermost commit
record was appended and fsynced are visible after recovery. Uncommitted
or rolled-back records in the log are ignored during replay.
"""

from __future__ import annotations

import json
import os

from .errors import CorruptError, StorageError, TxnError
from .faults import FaultInjector

MAX_NESTING = 3

_TOMBSTONE = object()

_OPS = ("begin", "put", "del", "commit", "rollback")


class _Frame:
    __slots__ = ("txn", "writes")

    def __init__(self, txn):
        self.txn = txn
        self.writes = {}  # key -> value | _TOMBSTONE


def _validate_record(rec):
    if not isinstance(rec, dict) or rec.get("op") not in _OPS:
        raise CorruptError("bad record")
    if not isinstance(rec.get("txn"), int):
        raise CorruptError("bad txn id")
    if rec["op"] in ("put", "del") and not isinstance(rec.get("key"), str):
        raise CorruptError("bad key")
    if rec["op"] == "put" and "value" not in rec:
        raise CorruptError("missing value")


class Store:
    def __init__(self, log_path, injector=None):
        self.log_path = str(log_path)
        self.injector = injector if injector is not None else FaultInjector()
        self._log = open(self.log_path, "a+b")
        self._log.seek(0, os.SEEK_END)
        self.committed = {}
        self.stack = []  # list[_Frame], bottom == outermost
        self._next_txn = 1
        self._txn_start_offset = None

    # -- internal helpers -------------------------------------------------

    def _append(self, record):
        self.injector.check("append_before")
        line = json.dumps(record, sort_keys=True).encode("utf-8") + b"\n"
        self._log.write(line)
        self._log.flush()

    def _abort_whole_txn(self):
        """fsync failure: make the whole transaction fully invisible."""
        self._log.flush()
        if self._txn_start_offset is not None:
            self._log.truncate(self._txn_start_offset)
            self._log.seek(0, os.SEEK_END)
        self.stack.clear()
        self._txn_start_offset = None

    # -- public operations -------------------------------------------------

    def begin(self):
        if len(self.stack) >= MAX_NESTING:
            raise TxnError(f"nesting deeper than {MAX_NESTING} levels")
        if not self.stack:
            self._log.flush()
            self._txn_start_offset = self._log.tell()
        txn = self._next_txn
        self._next_txn += 1
        self._append({"op": "begin", "txn": txn})
        self.stack.append(_Frame(txn))
        self.injector.check("append_after")

    def put(self, key, value):
        if not self.stack:
            raise TxnError("put outside transaction")
        if not isinstance(key, str):
            raise TxnError("key must be a string")
        self._append({"op": "put", "txn": self.stack[-1].txn, "key": key, "value": value})
        self.stack[-1].writes[key] = value
        self.injector.check("append_after")

    def delete(self, key):
        if not self.stack:
            raise TxnError("del outside transaction")
        self._append({"op": "del", "txn": self.stack[-1].txn, "key": key})
        self.stack[-1].writes[key] = _TOMBSTONE
        self.injector.check("append_after")

    def commit(self):
        if not self.stack:
            raise TxnError("commit without active transaction")
        frame = self.stack[-1]
        self._append({"op": "commit", "txn": frame.txn})
        if len(self.stack) > 1:
            # Inner commit: merge into parent frame, nothing durable yet.
            self.stack.pop()
            self.stack[-1].writes.update(frame.writes)
            self.injector.check("append_after")
            return
        # Outermost commit: this is the durability point.
        self.injector.check("append_after")
        try:
            self.injector.check("fsync_fail")
            self._log.flush()
            os.fsync(self._log.fileno())
        except StorageError:
            self._abort_whole_txn()
            raise
        for key, value in frame.writes.items():
            if value is _TOMBSTONE:
                self.committed.pop(key, None)
            else:
                self.committed[key] = value
        self.stack.pop()
        self._txn_start_offset = None
        self.injector.check("crash_after_commit")

    def rollback(self):
        if not self.stack:
            raise TxnError("rollback without active transaction")
        frame = self.stack[-1]
        self._append({"op": "rollback", "txn": frame.txn})
        self.stack.pop()
        if not self.stack:
            self._txn_start_offset = None
        self.injector.check("append_after")

    def view(self):
        """Currently visible view: committed state plus active txn writes."""
        out = dict(self.committed)
        for frame in self.stack:
            for key, value in frame.writes.items():
                if value is _TOMBSTONE:
                    out.pop(key, None)
                else:
                    out[key] = value
        return out

    def close(self):
        self._log.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def recover(log_path):
    """Replay the log and return (committed_view, truncated_corrupt_tail).

    Scanning stops at the first corrupt record; the file is truncated at
    that offset. Records committed before the corruption are preserved.
    """
    log_path = str(log_path)
    committed = {}
    stack = []
    corrupt_offset = None

    if not os.path.exists(log_path):
        return {}, False

    with open(log_path, "rb") as fh:
        while True:
            pos = fh.tell()
            line = fh.readline()
            if not line:
                break
            try:
                rec = json.loads(line.decode("utf-8"))
                _validate_record(rec)
            except (ValueError, UnicodeDecodeError, CorruptError):
                corrupt_offset = pos
                break
            _replay(rec, stack, committed)

    if corrupt_offset is not None:
        with open(log_path, "r+b") as fh:
            fh.truncate(corrupt_offset)

    return committed, corrupt_offset is not None


def _replay(rec, stack, committed):
    op = rec["op"]
    if op == "begin":
        stack.append({"txn": rec["txn"], "writes": {}})
        return
    if not stack or stack[-1]["txn"] != rec["txn"]:
        return  # record of an aborted/unknown txn: ignore
    frame = stack[-1]
    if op == "put":
        frame["writes"][rec["key"]] = rec["value"]
    elif op == "del":
        frame["writes"][rec["key"]] = _TOMBSTONE
    elif op == "rollback":
        stack.pop()
    elif op == "commit":
        stack.pop()
        if stack:
            stack[-1]["writes"].update(frame["writes"])
        else:
            for key, value in frame["writes"].items():
                if value is _TOMBSTONE:
                    committed.pop(key, None)
                else:
                    committed[key] = value
