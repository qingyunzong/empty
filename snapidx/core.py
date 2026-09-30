"""snapidx core: in-memory term index with snapshots, nested transactions,
and an optional write-ahead commit log.

Semantics
---------
- A document maps an id to a set of terms. ``add`` overwrites any existing
  document with the same id; ``delete`` of a missing id is a no-op.
- ``begin`` / ``commit`` / ``rollback`` implement nested transactions.
  A child commit merges its delta into the parent layer; rollback discards
  only the current (innermost) layer, outer layers continue.
- Only a non-empty outermost commit creates a new commit sequence number and
  a new snapshot. Committing an empty transaction is legal and leaves the
  sequence number unchanged.
- ``search(term, snapshot=S)`` reads the immutable committed state at the end
  of commit ``S``. Uncommitted changes are invisible to every snapshot, and a
  commit only affects snapshots created after it.
- Persistence: a log record is appended (and fsynced) only on a non-empty
  outermost commit. On recovery, replay stops at the first incomplete or
  corrupt record; the torn tail is discarded with a warning and truncated, so
  recovery always lands on the last complete commit.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

MAGIC = "SNAPIDX1"


class SnapIdxError(Exception):
    """State error. The CLI maps this to exit code 3."""


class NoTransactionError(SnapIdxError):
    """commit/rollback/add/del without an active transaction."""


class UnknownSnapshotError(SnapIdxError):
    """search --snapshot S with S outside [0, current seq]."""


def _default_warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def _encode_record(seq: int, layer: dict) -> bytes:
    ops = []
    for doc_id in sorted(layer):
        op, terms = layer[doc_id]
        if op == "add":
            ops.append(["a", doc_id, sorted(terms)])
        else:
            ops.append(["d", doc_id])
    payload = json.dumps({"seq": seq, "ops": ops},
                         separators=(",", ":"), sort_keys=True)
    raw = payload.encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    return f"{MAGIC} {len(raw)} {digest} {payload}\n".encode("utf-8")


def _parse_record(line: bytes):
    """Return the decoded record dict, or None if the line is not a valid
    complete record."""
    try:
        text = line.decode("utf-8")
        magic, length_s, digest, payload = text.split(" ", 3)
        if magic != MAGIC:
            return None
        raw = payload.encode("utf-8")
        if len(raw) != int(length_s):
            return None
        if hashlib.sha256(raw).hexdigest() != digest:
            return None
        record = json.loads(payload)
        if not isinstance(record, dict) or "seq" not in record or "ops" not in record:
            return None
        return record
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None


class SnapIdx:
    def __init__(self, log_path: str | None = None, warn=None):
        self._warn = warn or _default_warn
        self._committed: dict[str, frozenset] = {}
        # _snapshots[s] is the immutable committed state at end of commit s.
        self._snapshots: list[dict] = [{}]
        self._seq = 0
        # Stack of delta layers: doc_id -> ("add", frozenset) | ("del", None)
        self._txns: list[dict] = []
        self._log_path = log_path
        self._log_file = None
        if log_path is not None:
            self._recover()
            self._log_file = open(log_path, "ab")

    # ------------------------------------------------------------- recovery

    def _recover(self) -> None:
        try:
            with open(self._log_path, "rb") as fh:
                data = fh.read()
        except FileNotFoundError:
            return
        state: dict[str, frozenset] = {}
        snapshots: list[dict] = [{}]
        seq = 0
        pos = 0
        total = len(data)
        while pos < total:
            end = data.find(b"\n", pos)
            if end == -1:
                self._warn(
                    f"log truncated inside record at offset {pos}; "
                    f"discarding {total - pos} trailing byte(s)")
                break
            record = _parse_record(data[pos:end])
            if record is None or record["seq"] != seq + 1:
                self._warn(
                    f"invalid or incomplete log record at offset {pos}; "
                    f"discarding {total - pos} trailing byte(s)")
                break
            for op in record["ops"]:
                if op[0] == "a":
                    state[op[1]] = frozenset(op[2])
                else:
                    state.pop(op[1], None)
            seq += 1
            snapshots.append(dict(state))
            pos = end + 1
        self._committed = state
        self._snapshots = snapshots
        self._seq = seq
        if pos < total:
            # Drop the torn tail so future appends start at a clean boundary.
            os.truncate(self._log_path, pos)

    # ------------------------------------------------------------ accessors

    @property
    def seq(self) -> int:
        """Current commit sequence number (also the latest snapshot id)."""
        return self._seq

    @property
    def txn_depth(self) -> int:
        return len(self._txns)

    @property
    def in_transaction(self) -> bool:
        return bool(self._txns)

    def close(self) -> None:
        if self._log_file is not None:
            self._log_file.close()
            self._log_file = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    # ---------------------------------------------------------- transactions

    def _require_txn(self, what: str) -> None:
        if not self._txns:
            raise NoTransactionError(f"{what} without an active transaction")

    def begin(self) -> None:
        self._txns.append({})

    def add(self, doc_id: str, terms) -> None:
        self._require_txn("add")
        self._txns[-1][doc_id] = ("add", frozenset(terms))

    def delete(self, doc_id: str) -> None:
        self._require_txn("del")
        self._txns[-1][doc_id] = ("del", None)

    def commit(self) -> int | None:
        """Commit the innermost transaction.

        Returns the new commit sequence number for a non-empty outermost
        commit, or None for a nested commit or an empty outermost commit
        (which is legal and does not advance the sequence number).
        """
        self._require_txn("commit")
        layer = self._txns.pop()
        if self._txns:
            # Nested commit: merge child delta into the parent layer;
            # child operations override earlier parent operations.
            self._txns[-1].update(layer)
            return None
        if not layer:
            return None  # empty transaction: legal, seq unchanged
        for doc_id, (op, terms) in layer.items():
            if op == "add":
                self._committed[doc_id] = terms
            else:
                self._committed.pop(doc_id, None)
        self._seq += 1
        self._snapshots.append(dict(self._committed))
        if self._log_file is not None:
            record = _encode_record(self._seq, layer)
            self._log_file.write(record)
            self._log_file.flush()
            os.fsync(self._log_file.fileno())
        return self._seq

    def rollback(self) -> None:
        """Discard only the innermost transaction layer; outer layers and
        their uncommitted changes continue unaffected."""
        self._require_txn("rollback")
        self._txns.pop()

    # --------------------------------------------------------------- search

    def search(self, term: str, snapshot: int | None = None) -> list[str]:
        """Return sorted ids whose document contains ``term``.

        With ``snapshot=S`` reads the committed state at the end of commit S
        (never affected by uncommitted or later changes). Without it, reads
        the current view: committed state plus all open transaction layers.
        """
        if snapshot is not None:
            if not isinstance(snapshot, int) or not 0 <= snapshot <= self._seq:
                raise UnknownSnapshotError(
                    f"unknown snapshot {snapshot!r} (valid range: 0..{self._seq})")
            state = self._snapshots[snapshot]
            return sorted(doc_id for doc_id, terms in state.items()
                          if term in terms)
        view = dict(self._committed)
        for layer in self._txns:
            for doc_id, (op, terms) in layer.items():
                if op == "add":
                    view[doc_id] = terms
                else:
                    view.pop(doc_id, None)
        return sorted(doc_id for doc_id, terms in view.items()
                      if term in terms)
