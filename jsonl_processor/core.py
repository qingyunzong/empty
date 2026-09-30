"""Core engine: JSONL processing with atomic outputs, checkpointing, crash/recovery.

Semantics:
- Transform extracts only ``id``, ``name`` length and a CRC-32 checksum of the
  raw input line.
- Outputs are written atomically (temp file + ``os.replace``), one JSON file
  per record id under ``<workdir>/outputs/``.
- ``checkpoint.json`` records the maximum processed sequence number and is
  itself written atomically after every handled record.
- Crash points: AFTER_READ (before any processing of the record),
  AFTER_WRITE (after the output file is in place, before the checkpoint),
  AFTER_CHECKPOINT (after the checkpoint is written).
- Recovery scans existing output ids first, then verifies the checkpoint:
  records already checkpointed must have a trace (output / dead-letter /
  duplicate entry), otherwise recovery fails explicitly.  Records beyond the
  checkpoint whose output already exists (AFTER_WRITE crash) are skipped
  without rewriting; records with no output (AFTER_READ crash) are re-run.
- Bad records (e.g. missing ``name``) are attempted MAX_ATTEMPTS times, then
  appended to ``dead_letters.jsonl``; processing continues.
- Duplicate ids: only the first occurrence is processed, later ones are
  appended to ``duplicates.jsonl`` and never overwrite the existing output.
- Every invalid path/state raises an explicit error (ProcessorError).
"""
from __future__ import annotations

import json
import os
import tempfile
import zlib
from dataclasses import dataclass
from pathlib import Path

STATE_RUNNING = "RUNNING"
STATE_RECOVERING = "RECOVERING"
STATE_COMPLETED = "COMPLETED"
STATE_FAILED = "FAILED"

CRASH_AFTER_READ = "AFTER_READ"
CRASH_AFTER_WRITE = "AFTER_WRITE"
CRASH_AFTER_CHECKPOINT = "AFTER_CHECKPOINT"
CRASH_POINTS = (CRASH_AFTER_READ, CRASH_AFTER_WRITE, CRASH_AFTER_CHECKPOINT)

STATUS_WRITTEN = "written"
STATUS_SKIPPED_EXISTING = "skipped_existing"
STATUS_SKIPPED_CHECKPOINT = "skipped_checkpoint"
STATUS_DEAD_LETTER = "dead_letter"
STATUS_DUPLICATE = "duplicate"

MAX_ATTEMPTS = 3  # total attempts per record before dead-lettering


class ProcessorError(Exception):
    """Explicit, user-facing error (invalid paths, states, inconsistencies)."""


class SimulatedCrash(Exception):
    """Raised to simulate an abrupt process kill at a crash point."""

    def __init__(self, point: str, seq: int) -> None:
        self.point = point
        self.seq = seq
        super().__init__(f"simulated crash at {point} on seq {seq}")


class BadRecord(Exception):
    """A record that cannot be parsed/transformed (retried, then dead-lettered)."""


@dataclass
class RecordResult:
    seq: int
    record_id: object
    status: str
    attempts: int = 1


def _atomic_write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _validate_id(record_id: object) -> None:
    if isinstance(record_id, bool) or not isinstance(record_id, (str, int)):
        raise BadRecord(f"'id' must be a string or integer, got {type(record_id).__name__}")
    key = str(record_id)
    if not key or key in (".", "..") or "/" in key or "\\" in key or "\0" in key:
        raise BadRecord(f"'id' is not a safe file name: {key!r}")


def _parse_record(raw: str) -> dict:
    try:
        record = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BadRecord(f"invalid JSON: {exc}") from exc
    if not isinstance(record, dict):
        raise BadRecord("record is not a JSON object")
    if "id" not in record:
        raise BadRecord("missing 'id'")
    _validate_id(record["id"])
    return record


def transform(raw: str, record: dict) -> dict:
    """Extract only id, name length and checksum from a parsed record."""
    if "name" not in record:
        raise BadRecord("missing 'name'")
    name = record["name"]
    if not isinstance(name, str):
        raise BadRecord("'name' must be a string")
    checksum = f"{zlib.crc32(raw.encode('utf-8')) & 0xFFFFFFFF:08x}"
    return {"id": record["id"], "name_length": len(name), "checksum": checksum}


def _attempt(fn, *args):
    """Run fn up to MAX_ATTEMPTS times; return (value, error, attempts)."""
    attempts = 0
    err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        attempts = attempt
        try:
            return fn(*args), None, attempts
        except BadRecord as exc:
            err = str(exc)
    return None, err, attempts


def _peek_id(raw: str):
    """Best-effort id extraction for checkpoint verification; None if unknown."""
    try:
        record = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if isinstance(record, dict):
        return record.get("id")
    return None


class Workdir:
    def __init__(self, path) -> None:
        self.path = Path(path)
        self.outputs_dir = self.path / "outputs"
        self.checkpoint_path = self.path / "checkpoint.json"
        self.state_path = self.path / "state.json"
        self.dead_letters_path = self.path / "dead_letters.jsonl"
        self.duplicates_path = self.path / "duplicates.jsonl"

    def read_checkpoint(self) -> int:
        if not self.checkpoint_path.is_file():
            raise ProcessorError(f"checkpoint file missing: {self.checkpoint_path}")
        data = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
        return int(data["max_seq"])

    def write_checkpoint(self, max_seq: int) -> None:
        _atomic_write_json(self.checkpoint_path, {"max_seq": max_seq})

    def read_state(self) -> str:
        if not self.state_path.is_file():
            raise ProcessorError(f"state file missing: {self.state_path}")
        return json.loads(self.state_path.read_text(encoding="utf-8"))["state"]

    def write_state(self, state: str) -> None:
        _atomic_write_json(self.state_path, {"state": state})

    def scan_output_ids(self) -> set:
        if not self.outputs_dir.is_dir():
            return set()
        return {p.name[: -len(".json")] for p in self.outputs_dir.iterdir() if p.suffix == ".json"}

    def append_jsonl(self, path: Path, obj: dict) -> None:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(obj, ensure_ascii=False, sort_keys=True) + "\n")

    def read_jsonl_ids(self, path: Path) -> set:
        ids = set()
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    entry = json.loads(line)
                    if entry.get("id") is not None:
                        ids.add(str(entry["id"]))
        return ids


def run(input_path, workdir_path, *, recover=False, crash_point=None, crash_seq=None):
    """Process (or recover) a JSONL input; return a list of RecordResult."""
    input_path = Path(input_path)
    if not input_path.is_file():
        raise ProcessorError(f"input file not found: {input_path}")
    if crash_point is not None and crash_point not in CRASH_POINTS:
        raise ProcessorError(f"unknown crash point {crash_point!r}; expected one of {CRASH_POINTS}")
    if crash_point is not None and crash_seq is None:
        raise ProcessorError("crash simulation requires an explicit crash_seq")
    if crash_point is not None and recover:
        raise ProcessorError("cannot combine crash simulation with recovery")

    wd = Workdir(workdir_path)
    if recover:
        if not wd.state_path.is_file():
            raise ProcessorError(f"cannot recover: no state file in {wd.path} (nothing to recover)")
        if wd.read_state() == STATE_COMPLETED:
            raise ProcessorError("cannot recover: previous run already COMPLETED")
        start_seq = wd.read_checkpoint()
        wd.write_state(STATE_RECOVERING)
    else:
        if wd.state_path.exists():
            raise ProcessorError(f"workdir {wd.path} already initialized; use 'recover' or a fresh workdir")
        wd.outputs_dir.mkdir(parents=True, exist_ok=True)
        wd.write_checkpoint(-1)
        wd.write_state(STATE_RUNNING)
        start_seq = -1

    # Recovery step 1: scan existing output ids.
    preexisting_ids = wd.scan_output_ids()
    dead_ids = wd.read_jsonl_ids(wd.dead_letters_path)
    duplicate_ids = wd.read_jsonl_ids(wd.duplicates_path)
    written_ids = set()
    results: list[RecordResult] = []
    crash_triggered = False

    try:
        with input_path.open("r", encoding="utf-8") as fh:
            for seq, raw in enumerate(fh):
                raw = raw.rstrip("\n")

                if crash_point == CRASH_AFTER_READ and seq == crash_seq:
                    crash_triggered = True
                    raise SimulatedCrash(crash_point, seq)

                if seq <= start_seq:
                    # Recovery step 2: verify checkpoint against reality.
                    rec_id = _peek_id(raw)
                    key = str(rec_id) if rec_id is not None else None
                    if key is not None and (
                        key in preexisting_ids or key in dead_ids or key in duplicate_ids
                    ):
                        results.append(RecordResult(seq, rec_id, STATUS_SKIPPED_CHECKPOINT))
                        continue
                    raise ProcessorError(
                        f"checkpoint inconsistency at seq {seq}: max_seq={start_seq} but no "
                        f"output, dead-letter, or duplicate trace for id {rec_id!r}"
                    )

                record, err, attempts = _attempt(_parse_record, raw)
                if record is None:
                    wd.append_jsonl(wd.dead_letters_path, {
                        "seq": seq, "id": None, "reason": err,
                        "attempts": attempts, "raw": raw,
                    })
                    wd.write_checkpoint(seq)
                    results.append(RecordResult(seq, None, STATUS_DEAD_LETTER, attempts))
                    continue

                rec_id = record["id"]
                key = str(rec_id)

                if key in written_ids:
                    wd.append_jsonl(wd.duplicates_path, {"seq": seq, "id": rec_id, "raw": raw})
                    wd.write_checkpoint(seq)
                    results.append(RecordResult(seq, rec_id, STATUS_DUPLICATE))
                    continue

                value, err, attempts = _attempt(transform, raw, record)
                if value is None:
                    wd.append_jsonl(wd.dead_letters_path, {
                        "seq": seq, "id": rec_id, "reason": err,
                        "attempts": attempts, "raw": raw,
                    })
                    wd.write_checkpoint(seq)
                    results.append(RecordResult(seq, rec_id, STATUS_DEAD_LETTER, attempts))
                    continue

                value["seq"] = seq
                if key in preexisting_ids:
                    # AFTER_WRITE crash case: output already durable, do not rewrite.
                    status = STATUS_SKIPPED_EXISTING
                else:
                    _atomic_write_json(wd.outputs_dir / f"{key}.json", value)
                    status = STATUS_WRITTEN
                written_ids.add(key)
                results.append(RecordResult(seq, rec_id, status))

                if crash_point == CRASH_AFTER_WRITE and seq == crash_seq:
                    crash_triggered = True
                    raise SimulatedCrash(crash_point, seq)
                wd.write_checkpoint(seq)
                if crash_point == CRASH_AFTER_CHECKPOINT and seq == crash_seq:
                    crash_triggered = True
                    raise SimulatedCrash(crash_point, seq)

        if crash_point is not None and not crash_triggered:
            raise ProcessorError(
                f"crash point {crash_point} at seq {crash_seq} was never reached"
            )
        wd.write_state(STATE_COMPLETED)
        return results
    except SimulatedCrash:
        # Simulates an abrupt kill: state file is left stale (RUNNING).
        raise
    except Exception:
        wd.write_state(STATE_FAILED)
        raise
