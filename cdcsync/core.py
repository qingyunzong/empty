"""cdcsync core: apply JSONL change-data-capture logs to a SQLite KV store.

Exactly-once design
-------------------
* The checkpoint store (--ckpt) is a separate SQLite file that is ATTACHed
  to the main database connection.  All KV mutations, pending-table
  maintenance and checkpoint updates happen inside ONE SQLite transaction
  that spans both files (atomic in rollback-journal mode).  A crash after
  the KV writes but before the checkpoint writes therefore rolls back
  everything, and a restart simply replays the log idempotently.

* Per src, seq must be contiguous.  Events ahead of a gap are stored in a
  persistent ``pending`` table and are only applied once the gap is filled
  (possibly by a later run).  seq <= the checkpointed watermark is an
  idempotent no-op.

* Every log line carries a ``hash`` field.  The hash chain is computed over
  the events sorted by (src, seq) -- the canonical total order -- so log
  lines may arrive in any order and may be duplicated.  Any tampered or
  malformed line aborts the run with exit code 3 before the DB is touched.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3

GENESIS_HASH = "0" * 64
VALID_OPS = ("put", "del")

SCHEMA_MAIN = """
CREATE TABLE IF NOT EXISTS kv(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  src   TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  ts    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS pending(
  src   TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  op    TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT,
  ts    REAL NOT NULL,
  hash  TEXT NOT NULL,
  PRIMARY KEY(src, seq)
);
"""

SCHEMA_CKPT = """
CREATE TABLE IF NOT EXISTS ckpt.ckpt_state(
  src      TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);
"""


class FaultInject(Exception):
    """Injected crash point: after DB writes, before checkpoint writes."""


class LogValidationError(Exception):
    """The log contains bad JSON, bad schema, or a broken hash chain."""

    def __init__(self, errors, failed):
        super().__init__(errors[0] if errors else "log validation failed")
        self.errors = list(errors)
        self.failed = failed


# ---------------------------------------------------------------------------
# hashing / canonicalisation

def _canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _payload_of(event) -> dict:
    return {k: v for k, v in event.items() if k != "hash"}


def _chain_hash(prev_hash: str, payload: dict) -> str:
    return hashlib.sha256((prev_hash + _canonical(payload)).encode("utf-8")).hexdigest()


def chain_events(events):
    """Return copies of ``events`` (dicts without ``hash``) with the hash
    chain field filled in.  The chain runs over events sorted by (src, seq);
    duplicates of the same (src, seq) share one hash."""
    uniq = {}
    for ev in events:
        uniq.setdefault((ev["src"], ev["seq"]), ev)
    hashes = {}
    prev = GENESIS_HASH
    for key in sorted(uniq):
        hashes[key] = _chain_hash(prev, _payload_of(uniq[key]))
        prev = hashes[key]
    out = []
    for ev in events:
        stamped = dict(ev)
        stamped["hash"] = hashes[(ev["src"], ev["seq"])]
        out.append(stamped)
    return out


def dumps_log(events) -> str:
    """Serialise events to JSONL text (one JSON object per line)."""
    return "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events)


# ---------------------------------------------------------------------------
# validation

def _schema_ok(obj) -> bool:
    if not isinstance(obj, dict):
        return False
    src = obj.get("src")
    if not isinstance(src, str) or not src:
        return False
    seq = obj.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
        return False
    if obj.get("op") not in VALID_OPS:
        return False
    if not isinstance(obj.get("key"), str):
        return False
    if "value" not in obj:
        return False
    ts = obj.get("ts")
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return False
    h = obj.get("hash")
    if not isinstance(h, str) or len(h) != 64:
        return False
    return True


def parse_and_validate(text: str):
    """Parse and fully validate a JSONL log.  Returns the list of events in
    file order (duplicates kept).  Raises LogValidationError on any bad
    line; nothing is applied in that case."""
    errors = []
    failed = 0
    events = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            failed += 1
            errors.append(f"line {lineno}: invalid JSON: {exc}")
            continue
        if not _schema_ok(obj):
            failed += 1
            errors.append(f"line {lineno}: invalid event schema")
            continue
        events.append((lineno, obj))
    if failed:
        raise LogValidationError(errors, failed)

    # Deduplicate by (src, seq); conflicting duplicates mean tampering.
    by_key = {}
    for lineno, ev in events:
        key = (ev["src"], ev["seq"])
        if key in by_key:
            if _canonical(_payload_of(by_key[key][1])) != _canonical(_payload_of(ev)):
                failed += 1
                errors.append(f"line {lineno}: conflicting duplicate for src={key[0]!r} seq={key[1]}")
        else:
            by_key[key] = (lineno, ev)
    if failed:
        raise LogValidationError(errors, failed)

    # Verify the hash chain over the canonical (src, seq) total order.
    prev = GENESIS_HASH
    for key in sorted(by_key):
        lineno, ev = by_key[key]
        expected = _chain_hash(prev, _payload_of(ev))
        if ev["hash"] != expected:
            failed += 1
            errors.append(
                f"line {lineno}: hash chain mismatch at src={key[0]!r} seq={key[1]}"
            )
        prev = expected
    if failed:
        raise LogValidationError(errors, failed)

    return [ev for _, ev in events]


# ---------------------------------------------------------------------------
# apply

def _connect(db_path, ckpt_path):
    conn = sqlite3.connect(db_path, isolation_level=None)  # autocommit; explicit BEGIN
    conn.execute("PRAGMA journal_mode=DELETE")  # multi-file atomic commit needs non-WAL
    conn.executescript(SCHEMA_MAIN)
    conn.execute("ATTACH DATABASE ? AS ckpt", (ckpt_path,))
    conn.executescript(SCHEMA_CKPT)
    return conn


def apply_log(log_path, db_path, ckpt_path, *, fault_after_apply=None):
    """Apply a JSONL log to the KV store.  Returns a counts dict with keys
    applied/pending/failed/ignored.  Raises LogValidationError (exit 3
    semantics) before touching the DB if the log is invalid, and FaultInject
    at the injected crash point."""
    with open(log_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    events = parse_and_validate(text)  # raises before any DB write

    if fault_after_apply is None:
        fault_after_apply = bool(os.environ.get("CDCSYNC_FAULT_AFTER_APPLY"))

    conn = _connect(db_path, ckpt_path)
    try:
        conn.execute("BEGIN IMMEDIATE")

        last_seq = dict(conn.execute("SELECT src, last_seq FROM ckpt.ckpt_state"))
        pending = {}
        for src, seq, op, key, value, ts, h in conn.execute(
            "SELECT src, seq, op, key, value, ts, hash FROM pending"
        ):
            pending[(src, seq)] = {
                "src": src, "seq": seq, "op": op, "key": key,
                "value": json.loads(value), "ts": ts, "hash": h,
            }

        # Merge new events: first occurrence wins; old seqs are ignored.
        ignored = 0
        new_events = {}
        for ev in events:
            key = (ev["src"], ev["seq"])
            if key in pending or key in new_events:
                ignored += 1
                continue
            if ev["seq"] <= last_seq.get(ev["src"], 0):
                ignored += 1
                continue
            new_events[key] = ev

        pool = dict(pending)
        pool.update(new_events)

        # Per src, only the contiguous run above the watermark may apply.
        applicable = []
        for src in {k[0] for k in pool}:
            seq = last_seq.get(src, 0)
            while (src, seq + 1) in pool:
                seq += 1
                applicable.append(pool[(src, seq)])
        # Replay in the canonical (src, seq) total order.
        applicable.sort(key=lambda r: (r["src"], r["seq"]))

        # Phase 1: KV mutations + pending-table maintenance.
        applied = 0
        for rec in applicable:
            if rec["op"] == "put":
                conn.execute(
                    "INSERT INTO kv(key, value, src, seq, ts) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                    "src=excluded.src, seq=excluded.seq, ts=excluded.ts",
                    (rec["key"], _canonical(rec["value"]), rec["src"], rec["seq"], rec["ts"]),
                )
            else:  # del
                conn.execute("DELETE FROM kv WHERE key=?", (rec["key"],))
            conn.execute("DELETE FROM pending WHERE src=? AND seq=?", (rec["src"], rec["seq"]))
            applied += 1

        applied_keys = {(r["src"], r["seq"]) for r in applicable}
        for key, ev in new_events.items():
            if key not in applied_keys:
                conn.execute(
                    "INSERT OR IGNORE INTO pending(src, seq, op, key, value, ts, hash) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (ev["src"], ev["seq"], ev["op"], ev["key"],
                     _canonical(ev["value"]), ev["ts"], ev["hash"]),
                )

        # ---- injected crash point: after DB writes, before ckpt writes ----
        if fault_after_apply:
            raise FaultInject("fault injected after apply, before ckpt")

        # Phase 2: checkpoint updates (same transaction as phase 1).
        new_last = {}
        for rec in applicable:
            new_last[rec["src"]] = rec["seq"]
        for src, seq in new_last.items():
            conn.execute(
                "INSERT INTO ckpt.ckpt_state(src, last_seq) VALUES(?,?) "
                "ON CONFLICT(src) DO UPDATE SET last_seq=excluded.last_seq",
                (src, seq),
            )

        conn.execute("COMMIT")
        pending_count = conn.execute("SELECT COUNT(*) FROM pending").fetchone()[0]
        return {"applied": applied, "pending": pending_count, "failed": 0, "ignored": ignored}
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def dump_kv(db_path):
    """Return the KV store as a plain dict {key: value}."""
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT key, value FROM kv").fetchall()
    finally:
        conn.close()
    return {k: json.loads(v) for k, v in rows}
