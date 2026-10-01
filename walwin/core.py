"""walwin: WAL-backed sliding-window sum engine.

Semantics
---------
* Every input record is first appended to ``wal.log`` together with a CRC32
  and its ``seq``; the record is applied only after a ``commit`` marker for
  the same ``seq`` has been appended and fsynced.
* On recovery a corrupt WAL tail (bad CRC / unparseable) is truncated.
  Duplicate ``seq`` values are skipped idempotently.
* ``snapshot.json`` only contains committed records whose seqs form a
  contiguous prefix ``1..last_seq``.  Committed records beyond a gap stay
  pending in the WAL and are never reported as unsatisfiable.

Fault points (simulated via the ``FAULT_AT`` environment variable):
  P1 - WAL record appended, not yet fsynced.
  P2 - WAL record fsynced, commit marker not yet written.
  P3 - ``snapshot.tmp`` renamed to ``snapshot.json``, WAL not yet cleared.
  P4 - state durable, output not yet emitted.

P1/P2 recover as if the record never happened; P3 recovers as if it fully
happened (the WAL may then be cleared); P4 allows the output to be re-sent
without double-counting state.
"""
from __future__ import annotations

import json
import os
import sys
import zlib

WAL_NAME = "wal.log"
SNAP_NAME = "snapshot.json"

EXIT_OK = 0
EXIT_UNWRITABLE_DIR = 3

_RECORD_FIELDS = ("seq", "key", "ts", "delta")


def _crc(payload: dict) -> int:
    data = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return zlib.crc32(data) & 0xFFFFFFFF


def encode_entry(entry: dict) -> bytes:
    """Encode one WAL entry (dict without ``crc``) as a CRC-tagged JSON line."""
    body = {k: v for k, v in entry.items() if k != "crc"}
    out = dict(body)
    out["crc"] = _crc(body)
    return (json.dumps(out, separators=(",", ":")) + "\n").encode("utf-8")


def decode_entry(raw: bytes) -> dict:
    """Decode and CRC-verify one WAL line; raises ValueError on corruption."""
    entry = json.loads(raw.decode("utf-8"))
    if not isinstance(entry, dict) or "crc" not in entry:
        raise ValueError("malformed WAL entry")
    crc = entry.pop("crc")
    if crc != _crc(entry):
        raise ValueError("WAL entry CRC mismatch")
    return entry


def _fsync_dir(path: str) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fault(point: str) -> None:
    """Simulate a crash at a named fault point when FAULT_AT matches."""
    if os.environ.get("FAULT_AT") == point:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(2)


class WalWriter:
    """Append-only writer for wal.log using unbuffered os.write."""

    def __init__(self, path: str):
        self.path = path
        self.fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)

    def append(self, entry: dict) -> None:
        os.write(self.fd, encode_entry(entry))

    def fsync(self) -> None:
        os.fsync(self.fd)

    def close(self) -> None:
        os.close(self.fd)


class Engine:
    """Recovers, applies and snapshots the contiguous committed prefix."""

    def __init__(self, state_dir: str):
        self.state_dir = state_dir
        self.wal_path = os.path.join(state_dir, WAL_NAME)
        self.snap_path = os.path.join(state_dir, SNAP_NAME)
        self.last_seq = 0          # highest contiguous applied seq
        self.records = []          # applied records (contiguous prefix only)
        self.pending = {}          # committed but not yet contiguous: seq -> record

    # ------------------------------------------------------------------
    # Recovery
    # ------------------------------------------------------------------
    def recover(self) -> None:
        self._load_snapshot()
        entries = self._read_wal()
        recs = {}
        commits = set()
        for entry in entries:
            etype = entry.get("type")
            if etype == "rec":
                recs[entry["seq"]] = entry
            elif etype == "commit":
                commits.add(entry["seq"])
        for seq in sorted(commits):
            if seq in recs and seq > self.last_seq and seq not in self.pending:
                rec = recs[seq]
                self.pending[seq] = {k: rec[k] for k in _RECORD_FIELDS}
        self._drain_pending()

    def _load_snapshot(self) -> None:
        if not os.path.exists(self.snap_path):
            return
        with open(self.snap_path, "r", encoding="utf-8") as fh:
            snap = json.load(fh)
        self.last_seq = int(snap.get("last_seq", 0))
        self.records = list(snap.get("records", []))

    def _read_wal(self) -> list:
        """Read valid WAL entries, truncating a corrupt tail in place."""
        if not os.path.exists(self.wal_path):
            return []
        with open(self.wal_path, "rb") as fh:
            data = fh.read()
        entries = []
        valid_len = 0
        for line in data.splitlines(keepends=True):
            stripped = line.strip()
            if not stripped:
                break
            try:
                entry = decode_entry(stripped)
            except ValueError:
                break  # corrupt tail: everything from here on is dropped
            entries.append(entry)
            valid_len += len(line)
        if valid_len < len(data):
            with open(self.wal_path, "r+b") as fh:
                fh.truncate(valid_len)
                fh.flush()
                os.fsync(fh.fileno())
        return entries

    # ------------------------------------------------------------------
    # Live processing
    # ------------------------------------------------------------------
    def process(self, record: dict, wal: WalWriter) -> bool:
        seq = record["seq"]
        if seq <= self.last_seq or seq in self.pending:
            return False  # duplicate seq: idempotent skip
        wal.append({"type": "rec", **{k: record[k] for k in _RECORD_FIELDS}})
        _fault("P1")  # appended to WAL, not yet fsynced
        wal.fsync()
        _fault("P2")  # fsynced, commit marker not yet written
        wal.append({"type": "commit", "seq": seq})
        wal.fsync()
        self.pending[seq] = {k: record[k] for k in _RECORD_FIELDS}
        self._drain_pending()
        return True

    def _drain_pending(self) -> None:
        while self.last_seq + 1 in self.pending:
            self.last_seq += 1
            self.records.append(self.pending.pop(self.last_seq))

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------
    def snapshot(self) -> None:
        tmp = self.snap_path + ".tmp"
        payload = {"last_seq": self.last_seq, "records": self.records}
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.snap_path)
        _fsync_dir(self.state_dir)
        _fault("P3")  # snapshot renamed, WAL not yet cleared
        self._rewrite_wal()

    def _rewrite_wal(self) -> None:
        """Clear the WAL, keeping only still-pending (non-contiguous) records."""
        tmp = self.wal_path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        try:
            for seq in sorted(self.pending):
                os.write(fd, encode_entry({"type": "rec", **self.pending[seq]}))
                os.write(fd, encode_entry({"type": "commit", "seq": seq}))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, self.wal_path)
        _fsync_dir(self.state_dir)

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------
    def window_sum(self, win: int) -> dict:
        """Sum deltas of applied records with ts in (max_ts - win, max_ts]."""
        if not self.records:
            return {"window_sum": 0, "max_ts": None, "win": win,
                    "applied": self.last_seq}
        max_ts = max(r["ts"] for r in self.records)
        low = max_ts - win
        total = sum(r["delta"] for r in self.records if low < r["ts"] <= max_ts)
        return {"window_sum": total, "max_ts": max_ts, "win": win,
                "applied": self.last_seq}


def run(input_path: str, state_dir: str, win: int) -> int:
    try:
        os.makedirs(state_dir, exist_ok=True)
        probe = os.path.join(state_dir, ".write_probe")
        with open(probe, "w") as fh:
            fh.write("")
        os.remove(probe)
    except OSError:
        print(f"walwin: state directory not writable: {state_dir}",
              file=sys.stderr)
        return EXIT_UNWRITABLE_DIR

    engine = Engine(state_dir)
    engine.recover()

    wal = WalWriter(engine.wal_path)
    try:
        with open(input_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                engine.process(json.loads(line), wal)
    finally:
        wal.close()

    engine.snapshot()
    _fault("P4")  # state durable, output not yet emitted
    sys.stdout.write(json.dumps(engine.window_sum(win)) + "\n")
    sys.stdout.flush()
    return EXIT_OK
