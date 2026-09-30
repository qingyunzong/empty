"""cdcsync core engine.

Applies a JSONL change-data-capture (CDC) log to a SQLite key/value table
with exactly-once semantics.

Exactly-once design
-------------------
The checkpoint (per-source ``next_seq``) lives in the same SQLite database
as the key/value table and the pending table.  Every log record is applied
inside a single SQLite transaction that performs, in order:

1. the KV mutation (INSERT/DELETE on ``kv``),
2. the checkpoint update (``ckpt.next_seq``),
3. any pending-table bookkeeping (gap buffering / cascade replay).

A crash at any point -- including the classic "after the DB write, before
the checkpoint write" window -- rolls the whole transaction back, so after
a restart the record is simply replayed from the log and applied exactly
once.  Records with ``seq < next_seq`` are idempotently skipped.

The ``--ckpt CK`` file is an atomically written JSON *mirror* of the
checkpoint table (exported after every commit, imported only when the
database checkpoint table is empty, e.g. the DB file was recreated).

Log format
----------
One JSON object per line with fields ``src, seq, op, key, value, ts, hash``.
``hash`` chains each record to its predecessor::

    hash[i] = sha256(hash[i-1] + "\\n" + canonical_json(payload[i]))

with ``hash[0]`` computed over ``GENESIS``.  ``payload`` is the record
without the ``hash`` field, serialised with sorted keys and compact
separators.  A broken chain or invalid JSON aborts the run with exit
code 3 and leaves the database at the last committed (consistent) point.

Ordering semantics
------------------
Per ``src``, ``seq`` starts at 1 and must be contiguous.  A record whose
``seq`` is ahead of the checkpoint is buffered in the ``pending`` table
and is never applied out of order; when the gap is filled the buffered
records cascade-apply inside the same transaction.

Records may also arrive out of order *across* sources.  Every key carries
a ``(vsrc, vseq)`` version (deletes are tombstones, not row removals), and
an event only mutates a key when its ``(src, seq)`` is newer than the
stored version.  The store therefore converges to last-writer-wins in
``(src, seq)`` order regardless of arrival order: the final state is
identical to replaying all records sorted by ``(src, seq)``.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3

GENESIS = "0" * 64

OPS_PUT = frozenset({"put", "set", "upsert"})
OPS_DEL = frozenset({"del", "delete", "remove"})
PAYLOAD_FIELDS = ("src", "seq", "op", "key", "value", "ts")

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT,          -- NULL is a tombstone (deleted)
    vsrc  TEXT NOT NULL, -- version: src of the last applied event
    vseq  INTEGER NOT NULL -- version: seq of the last applied event
);
CREATE TABLE IF NOT EXISTS ckpt (
    src      TEXT PRIMARY KEY,
    next_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending (
    src   TEXT NOT NULL,
    seq   INTEGER NOT NULL,
    op    TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT,
    ts    REAL,
    PRIMARY KEY (src, seq)
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class FaultInject(Exception):
    """Testing hook: raised after the KV write, before the ckpt write."""


class CorruptLog(Exception):
    """The log contains invalid JSON or a broken hash chain."""


def canonical(payload) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def record_hash(payload, prev_hash: str) -> str:
    h = hashlib.sha256()
    h.update(prev_hash.encode("utf-8"))
    h.update(b"\n")
    h.update(canonical(payload).encode("utf-8"))
    return h.hexdigest()


def payload_of(rec: dict) -> dict:
    return {k: rec[k] for k in PAYLOAD_FIELDS}


class Engine:
    """Applies CDC log records to a SQLite KV store."""

    def __init__(self, db_path: str, ckpt_path: str | None = None):
        self.db_path = db_path
        self.ckpt_path = ckpt_path
        self.conn = sqlite3.connect(db_path)
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self._import_ckpt_file()
        self.counts = {"applied": 0, "pending": 0, "failed": 0,
                       "duplicates": 0}
        self._applied_this_run = 0
        fault = os.environ.get("CDCSYNC_FAULT_AFTER")
        self._fault_after = int(fault) if fault else None

    # ------------------------------------------------------------- checkpoint

    def _import_ckpt_file(self) -> None:
        """Seed the ckpt table from the CK file if the DB has none."""
        if not self.ckpt_path or not os.path.exists(self.ckpt_path):
            return
        if self.conn.execute("SELECT COUNT(*) FROM ckpt").fetchone()[0]:
            return
        try:
            with open(self.ckpt_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return
        for src, nxt in data.get("next_seq", {}).items():
            self.conn.execute(
                "INSERT OR IGNORE INTO ckpt(src, next_seq) VALUES(?, ?)",
                (src, int(nxt)))
        self.conn.commit()

    def _sync_ckpt_file(self) -> None:
        """Atomically mirror the ckpt table to the CK file."""
        if not self.ckpt_path:
            return
        rows = self.conn.execute("SELECT src, next_seq FROM ckpt").fetchall()
        data = {"next_seq": {src: nxt for src, nxt in rows}}
        tmp = self.ckpt_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, self.ckpt_path)

    def snapshot(self) -> dict:
        """Current counters; ``pending`` reflects the pending table size."""
        self.counts["pending"] = self.conn.execute(
            "SELECT COUNT(*) FROM pending").fetchone()[0]
        return dict(self.counts)

    # --------------------------------------------------------------- applying

    def _maybe_fault(self) -> None:
        if (self._fault_after is not None
                and self._applied_this_run >= self._fault_after):
            raise FaultInject(
                f"fault injected after {self._applied_this_run} applied "
                "event(s): after DB write, before ckpt write")

    def _apply_one(self, src: str, seq: int, op: str, key: str,
                   value) -> None:
        """KV write, fault window, then ckpt write (one transaction)."""
        if op in OPS_PUT or op in OPS_DEL:
            row = self.conn.execute(
                "SELECT vsrc, vseq FROM kv WHERE key = ?", (key,)).fetchone()
            if row is None or (src, seq) > (row[0], row[1]):
                new_value = canonical(value) if op in OPS_PUT else None
                self.conn.execute(
                    "INSERT INTO kv(key, value, vsrc, vseq) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
                    "vsrc = excluded.vsrc, vseq = excluded.vseq",
                    (key, new_value, src, seq))
            self.counts["applied"] += 1
        else:
            # Structurally valid record, unknown op: consume it (advance
            # the checkpoint) but count it as failed.
            self.counts["failed"] += 1
        self._applied_this_run += 1
        self._maybe_fault()
        self.conn.execute(
            "INSERT INTO ckpt(src, next_seq) VALUES(?, ?) "
            "ON CONFLICT(src) DO UPDATE SET next_seq = excluded.next_seq",
            (src, seq + 1))

    def apply_record(self, rec: dict) -> None:
        """Apply one validated record inside a single transaction."""
        src, seq = rec["src"], rec["seq"]
        with self.conn:  # commits on success, rolls back on exception
            row = self.conn.execute(
                "SELECT next_seq FROM ckpt WHERE src = ?", (src,)).fetchone()
            next_seq = row[0] if row else 1
            if seq < next_seq:
                self.counts["duplicates"] += 1
                return
            if seq > next_seq:
                cur = self.conn.execute(
                    "INSERT OR IGNORE INTO pending"
                    "(src, seq, op, key, value, ts) VALUES(?, ?, ?, ?, ?, ?)",
                    (src, seq, rec["op"], rec["key"],
                     canonical(rec["value"]), rec["ts"]))
                if cur.rowcount == 0:
                    self.counts["duplicates"] += 1
                return
            self._apply_one(src, seq, rec["op"], rec["key"], rec["value"])
            nxt = seq + 1
            while True:
                row = self.conn.execute(
                    "SELECT op, key, value FROM pending"
                    " WHERE src = ? AND seq = ?", (src, nxt)).fetchone()
                if row is None:
                    break
                self.conn.execute(
                    "DELETE FROM pending WHERE src = ? AND seq = ?",
                    (src, nxt))
                value = json.loads(row[2]) if row[2] is not None else None
                self._apply_one(src, nxt, row[0], row[1], value)
                nxt += 1

    # ------------------------------------------------------------------- run

    def run(self, log_path: str) -> dict:
        """Apply ``log_path``; returns the counter snapshot."""
        prev_hash = GENESIS
        with open(log_path, "r", encoding="utf-8") as fh:
            for lineno, raw in enumerate(fh, 1):
                line = raw.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise CorruptLog(
                        f"line {lineno}: invalid JSON: {exc}") from exc
                self._validate(rec, lineno)
                payload = payload_of(rec)
                expected = record_hash(payload, prev_hash)
                if rec["hash"] != expected:
                    raise CorruptLog(
                        f"line {lineno}: hash chain broken "
                        f"(expected {expected}, got {rec['hash']})")
                prev_hash = rec["hash"]
                self.apply_record(rec)
                self._sync_ckpt_file()
        return self.snapshot()

    @staticmethod
    def _validate(rec, lineno: int) -> None:
        if not isinstance(rec, dict):
            raise CorruptLog(f"line {lineno}: record is not a JSON object")
        missing = [k for k in (*PAYLOAD_FIELDS, "hash") if k not in rec]
        if missing:
            raise CorruptLog(
                f"line {lineno}: missing field(s): {', '.join(missing)}")
        if not isinstance(rec["src"], str) or not rec["src"]:
            raise CorruptLog(f"line {lineno}: 'src' must be a string")
        if (not isinstance(rec["seq"], int)
                or isinstance(rec["seq"], bool) or rec["seq"] < 1):
            raise CorruptLog(
                f"line {lineno}: 'seq' must be a positive integer")
        if not isinstance(rec["op"], str):
            raise CorruptLog(f"line {lineno}: 'op' must be a string")
        if not isinstance(rec["key"], str):
            raise CorruptLog(f"line {lineno}: 'key' must be a string")
        if not isinstance(rec["ts"], (int, float)):
            raise CorruptLog(f"line {lineno}: 'ts' must be a number")
        if not isinstance(rec["hash"], str):
            raise CorruptLog(f"line {lineno}: 'hash' must be a string")

    def close(self) -> None:
        self.conn.close()
