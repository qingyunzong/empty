#!/usr/bin/env python3
"""Idempotent task inbox CLI.

Tasks are JSON objects with "idemkey" and "payload". State is persisted in a
store directory:

  inbox.json        task records keyed by idemkey (the persistent inbox)
  results.json      results keyed by idemkey (the persistent result file)
  events.jsonl      append-only event log (RECEIVED / CLAIM / RESULT events)
  effects.json      applied side effects keyed by effect key (idemkey)
  compute_log.jsonl one line per real processor computation (test observability)

Commands: enqueue, run-once, crash --after CLAIM, recover, get.

Exit codes:
  0  success
  2  duplicate run while task is PROCESSING
  4  invalid input / corrupted store
  10 permanent failure (payload == "BAD")
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

EXIT_OK = 0
EXIT_PROCESSING_DUPLICATE = 2
EXIT_INVALID_INPUT = 4
EXIT_PERMANENT_FAILURE = 10

RECEIVED = "RECEIVED"
PROCESSING = "PROCESSING"
SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"

BAD_PAYLOAD = "BAD"


class InvalidInput(Exception):
    """Raised for malformed tasks, unknown keys, bad arguments (exit 4)."""


class StoreCorrupted(Exception):
    """Raised when a persisted store file cannot be parsed (exit 4)."""


class PermanentFailure(Exception):
    """Raised by the processor for permanently unprocessable payloads."""


class Store:
    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)
        self.inbox_path = self.root / "inbox.json"
        self.results_path = self.root / "results.json"
        self.events_path = self.root / "events.jsonl"
        self.effects_path = self.root / "effects.json"
        self.compute_log_path = self.root / "compute_log.jsonl"

    def _load_json(self, path: Path, default):
        if not path.exists():
            return default
        try:
            with path.open("r", encoding="utf-8") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            raise StoreCorrupted(
                f"store file corrupted: {path}: {exc}"
            ) from exc

    def _atomic_write_json(self, path: Path, data) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _append_line(self, path: Path, record: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
        # O_APPEND write of a single line + fsync: atomic event persistence.
        with path.open("a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())

    def load_inbox(self) -> dict:
        return self._load_json(self.inbox_path, {})

    def save_inbox(self, inbox: dict) -> None:
        self._atomic_write_json(self.inbox_path, inbox)

    def load_results(self) -> dict:
        return self._load_json(self.results_path, {})

    def save_results(self, results: dict) -> None:
        self._atomic_write_json(self.results_path, results)

    def load_effects(self) -> dict:
        return self._load_json(self.effects_path, {})

    def save_effects(self, effects: dict) -> None:
        self._atomic_write_json(self.effects_path, effects)

    def append_event(self, record: dict) -> None:
        self._append_line(self.events_path, record)

    def log_compute(self, record: dict) -> None:
        self._append_line(self.compute_log_path, record)


def builtin_processor(store: Store, record: dict) -> str:
    """Built-in processor, idempotent by effect key.

    The side effect of processing is keyed by the idemkey. If the effect for
    this key has already been applied, the recorded effect is returned without
    recomputing, so re-running after a crash never duplicates side effects.
    """
    idemkey = record["idemkey"]
    payload = record["payload"]
    if payload == BAD_PAYLOAD:
        raise PermanentFailure("payload 'BAD' is permanently unprocessable")
    effects = store.load_effects()
    if idemkey in effects:
        return effects[idemkey]
    effect = f"effect[{idemkey}]={payload}"
    store.log_compute({"idemkey": idemkey, "effect": effect})
    effects[idemkey] = effect
    store.save_effects(effects)
    return effect


def parse_task(text: str) -> dict:
    try:
        task = json.loads(text)
    except json.JSONDecodeError as exc:
        raise InvalidInput(f"invalid task JSON: {exc}") from exc
    if not isinstance(task, dict):
        raise InvalidInput("task must be a JSON object")
    for field in ("idemkey", "payload"):
        if field not in task:
            raise InvalidInput(f"missing required field: {field}")
    if not isinstance(task["idemkey"], str) or not task["idemkey"]:
        raise InvalidInput("idemkey must be a non-empty string")
    return task


def enqueue(store: Store, task: dict):
    """First enqueue accepts; duplicate idemkey returns the original record."""
    inbox = store.load_inbox()
    idemkey = task["idemkey"]
    if idemkey in inbox:
        return inbox[idemkey], False
    record = {
        "idemkey": idemkey,
        "payload": task["payload"],
        "status": RECEIVED,
        "attempts": 0,
        "result": None,
        "error": None,
    }
    inbox[idemkey] = record
    store.save_inbox(inbox)
    store.append_event({"event": "RECEIVED", "idemkey": idemkey})
    return record, True


def claim(store: Store, idemkey: str) -> dict:
    """Atomically write the CLAIM event, then mark the task PROCESSING."""
    inbox = store.load_inbox()
    record = inbox[idemkey]
    record["attempts"] += 1
    store.append_event(
        {"event": "CLAIM", "idemkey": idemkey, "attempt": record["attempts"]}
    )
    record["status"] = PROCESSING
    store.save_inbox(inbox)
    return record


def complete(store: Store, idemkey: str, result=None, error=None) -> dict:
    inbox = store.load_inbox()
    record = inbox[idemkey]
    if error is None:
        record["status"] = SUCCEEDED
        record["result"] = result
        record["error"] = None
        results = store.load_results()
        results[idemkey] = result
        store.save_results(results)
        store.append_event(
            {"event": "RESULT", "idemkey": idemkey, "status": SUCCEEDED,
             "result": result}
        )
    else:
        record["status"] = FAILED
        record["error"] = error
        store.append_event(
            {"event": "RESULT", "idemkey": idemkey, "status": FAILED,
             "error": error}
        )
    store.save_inbox(inbox)
    return record


def process_record(store: Store, idemkey: str):
    """Claim, run the idempotent processor, persist the result."""
    claim(store, idemkey)
    try:
        effect = builtin_processor(store, store.load_inbox()[idemkey])
    except PermanentFailure as exc:
        record = complete(store, idemkey, error=str(exc))
        return record, EXIT_PERMANENT_FAILURE
    record = complete(store, idemkey, result=effect)
    return record, EXIT_OK


def run_once(store: Store, idemkey: str | None = None):
    inbox = store.load_inbox()
    if idemkey is not None:
        if idemkey not in inbox:
            raise InvalidInput(f"unknown idemkey: {idemkey}")
        record = inbox[idemkey]
    else:
        record = next(
            (r for r in inbox.values() if r["status"] == RECEIVED), None
        )
        if record is None:
            return None, EXIT_OK
    status = record["status"]
    if status == PROCESSING:
        return record, EXIT_PROCESSING_DUPLICATE
    if status == SUCCEEDED:
        return record, EXIT_OK
    if status == FAILED:
        return record, EXIT_PERMANENT_FAILURE
    return process_record(store, record["idemkey"])


def recover(store: Store):
    """Re-run tasks that crashed after CLAIM, using the same idemkey."""
    inbox = store.load_inbox()
    crashed = [r for r in inbox.values() if r["status"] == PROCESSING]
    results = []
    code = EXIT_OK
    for record in crashed:
        done, rc = process_record(store, record["idemkey"])
        results.append(done)
        if rc != EXIT_OK:
            code = rc
    return results, code


def crash_after_claim(store: Store, idemkey: str) -> dict:
    """Test hook: write CLAIM, mark PROCESSING, then 'crash' (no result)."""
    inbox = store.load_inbox()
    if idemkey not in inbox:
        raise InvalidInput(f"unknown idemkey: {idemkey}")
    if inbox[idemkey]["status"] != RECEIVED:
        raise InvalidInput(
            f"task {idemkey} is {inbox[idemkey]['status']}, cannot crash after CLAIM"
        )
    return claim(store, idemkey)


def get_task(store: Store, idemkey: str) -> dict:
    inbox = store.load_inbox()
    if idemkey not in inbox:
        raise InvalidInput(f"unknown idemkey: {idemkey}")
    record = inbox[idemkey]
    store.load_results()  # validate result file integrity
    return {
        "idemkey": record["idemkey"],
        "status": record["status"],
        "attempts": record["attempts"],
        "result": record["result"],
        "error": record["error"],
    }


def emit(record) -> None:
    print(json.dumps(record, ensure_ascii=False, sort_keys=True))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="idem", description=__doc__)
    parser.add_argument("--store", default="./store", help="store directory")
    sub = parser.add_subparsers(dest="command", required=True)

    p_enqueue = sub.add_parser("enqueue", help="enqueue a task JSON")
    p_enqueue.add_argument("task", help="task JSON with idemkey and payload")

    p_run = sub.add_parser("run-once", help="process one pending task")
    p_run.add_argument("--idemkey", default=None)

    p_crash = sub.add_parser("crash", help="simulate a crash")
    p_crash.add_argument("--after", required=True, choices=["CLAIM"])
    p_crash.add_argument("--idemkey", required=True)

    sub.add_parser("recover", help="re-run tasks crashed after CLAIM")

    p_get = sub.add_parser("get", help="show status, result and attempts")
    p_get.add_argument("--idemkey", required=True)

    args = parser.parse_args(argv)
    store = Store(args.store)

    try:
        if args.command == "enqueue":
            task = parse_task(args.task)
            record, created = enqueue(store, task)
            emit({"accepted": created, "task": record})
            return EXIT_OK
        if args.command == "run-once":
            record, code = run_once(store, args.idemkey)
            if record is None:
                emit({"message": "no pending tasks"})
            else:
                emit(record)
            return code
        if args.command == "crash":
            record = crash_after_claim(store, args.idemkey)
            emit({"crashed": True, "after": "CLAIM", "task": record})
            return EXIT_OK
        if args.command == "recover":
            records, code = recover(store)
            emit({"recovered": records})
            return code
        if args.command == "get":
            emit(get_task(store, args.idemkey))
            return EXIT_OK
    except InvalidInput as exc:
        print(f"error: invalid input: {exc}", file=sys.stderr)
        return EXIT_INVALID_INPUT
    except StoreCorrupted as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID_INPUT
    return EXIT_INVALID_INPUT


if __name__ == "__main__":
    sys.exit(main())
