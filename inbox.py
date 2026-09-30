#!/usr/bin/env python3
"""Idempotent persistent task inbox.

Commands: enqueue, run-once, crash --after CLAIM, recover, get.
States: RECEIVED, PROCESSING, SUCCEEDED, FAILED.

Exit codes:
  0  success
  2  duplicate run while a task is PROCESSING
  3  persistent storage corrupted
  4  invalid input
  10 permanent processing failure
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

EXIT_OK = 0
EXIT_PROCESSING_DUPLICATE = 2
EXIT_STORAGE_CORRUPT = 3
EXIT_INVALID_INPUT = 4
EXIT_PERMANENT_FAILURE = 10

RECEIVED = "RECEIVED"
PROCESSING = "PROCESSING"
SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"

CLAIM_TOKEN = "CLAIM"


class InvalidInputError(Exception):
    pass


class CorruptStorageError(Exception):
    pass


class Inbox:
    """Persistent inbox backed by an append-only journal plus JSON state files."""

    def __init__(self, directory: str) -> None:
        self.dir = directory
        os.makedirs(directory, exist_ok=True)
        self.journal_path = os.path.join(directory, "journal.log")
        self.results_path = os.path.join(directory, "results.json")
        self.effects_path = os.path.join(directory, "effects.json")

    # -- storage primitives -------------------------------------------------

    def _load_json(self, path: str, default):
        if not os.path.exists(path):
            return default
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
            raise CorruptStorageError(f"corrupt file {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise CorruptStorageError(
                f"corrupt file {path}: expected a JSON object"
            )
        return data

    def _store_json(self, path: str, data) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".tmp-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2, sort_keys=True)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _append_event(self, event: dict) -> None:
        with open(self.journal_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def load_results(self) -> dict:
        return self._load_json(self.results_path, {})

    def load_effects(self) -> dict:
        return self._load_json(self.effects_path, {})

    # -- operations ---------------------------------------------------------

    def enqueue(self, task: dict) -> tuple[dict, bool]:
        """Returns (record, created). Duplicate idemkeys return the original."""
        idemkey = task["idemkey"]
        results = self.load_results()
        if idemkey in results:
            return results[idemkey], False
        record = {
            "idemkey": idemkey,
            "payload": task["payload"],
            "status": RECEIVED,
            "result": None,
            "attempts": 0,
        }
        results[idemkey] = record
        self._store_json(self.results_path, results)
        self._append_event({"event": "ENQUEUE", "idemkey": idemkey})
        return record, True

    def claim(self, results: dict, idemkey: str) -> None:
        """Atomically persist a CLAIM event before any processing happens."""
        record = results[idemkey]
        record["attempts"] += 1
        record["status"] = PROCESSING
        self._store_json(self.results_path, results)
        self._append_event(
            {"event": CLAIM_TOKEN, "idemkey": idemkey, "attempt": record["attempts"]}
        )

    def apply_effect(self, idemkey: str, payload) -> str:
        """Idempotent side effect keyed by the idemkey (effect key)."""
        effects = self.load_effects()
        if idemkey not in effects:
            effects[idemkey] = f"applied:{payload}"
            self._store_json(self.effects_path, effects)
        return effects[idemkey]

    def process(self, results: dict, idemkey: str) -> int:
        record = results[idemkey]
        if record["payload"] == "BAD":
            record["status"] = FAILED
            record["result"] = {"error": "permanent failure: BAD payload"}
            self._store_json(self.results_path, results)
            self._append_event(
                {"event": "RESULT", "idemkey": idemkey, "status": FAILED}
            )
            return EXIT_PERMANENT_FAILURE
        effect = self.apply_effect(idemkey, record["payload"])
        record["status"] = SUCCEEDED
        record["result"] = {"payload": record["payload"], "effect": effect}
        self._store_json(self.results_path, results)
        self._append_event(
            {"event": "RESULT", "idemkey": idemkey, "status": SUCCEEDED}
        )
        return EXIT_OK


def parse_task(raw: str) -> dict:
    try:
        task = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InvalidInputError(f"task is not valid JSON: {exc}") from exc
    if not isinstance(task, dict):
        raise InvalidInputError("task must be a JSON object")
    if "idemkey" not in task:
        raise InvalidInputError("task is missing required field 'idemkey'")
    if "payload" not in task:
        raise InvalidInputError("task is missing required field 'payload'")
    if not isinstance(task["idemkey"], str) or not task["idemkey"]:
        raise InvalidInputError("field 'idemkey' must be a non-empty string")
    return task


def emit(record: dict, note: str) -> None:
    print(json.dumps({"note": note, "task": record}, sort_keys=True))


def cmd_enqueue(inbox: Inbox, raw: str) -> int:
    record, created = inbox.enqueue(parse_task(raw))
    emit(record, "accepted" if created else "duplicate")
    return EXIT_OK


def cmd_run_once(inbox: Inbox, idemkey: str | None) -> int:
    results = inbox.load_results()
    if idemkey is not None:
        if idemkey not in results:
            raise InvalidInputError(f"unknown idemkey: {idemkey}")
        record = results[idemkey]
        if record["status"] == PROCESSING:
            emit(record, "already processing")
            return EXIT_PROCESSING_DUPLICATE
        if record["status"] == SUCCEEDED:
            emit(record, "already succeeded")
            return EXIT_OK
        if record["status"] == FAILED:
            emit(record, "permanently failed")
            return EXIT_PERMANENT_FAILURE
    else:
        idemkey = next(
            (k for k, r in results.items() if r["status"] == RECEIVED), None
        )
        if idemkey is None:
            if any(r["status"] == PROCESSING for r in results.values()):
                print("error: a task is still PROCESSING", file=sys.stderr)
                return EXIT_PROCESSING_DUPLICATE
            print("no pending tasks")
            return EXIT_OK
    inbox.claim(results, idemkey)
    code = inbox.process(results, idemkey)
    emit(results[idemkey], "processed")
    return code


def cmd_crash(inbox: Inbox, idemkey: str) -> int:
    results = inbox.load_results()
    if idemkey not in results:
        raise InvalidInputError(f"unknown idemkey: {idemkey}")
    record = results[idemkey]
    if record["status"] != RECEIVED:
        raise InvalidInputError(
            f"cannot crash task in state {record['status']}"
        )
    inbox.claim(results, idemkey)
    print(f"simulated crash after CLAIM of {idemkey}", file=sys.stderr)
    return 1  # crash: no result written


def cmd_recover(inbox: Inbox) -> int:
    results = inbox.load_results()
    pending = [k for k, r in results.items() if r["status"] == PROCESSING]
    if not pending:
        print("nothing to recover")
        return EXIT_OK
    worst = EXIT_OK
    for idemkey in pending:
        inbox.claim(results, idemkey)  # re-run with the same idemkey
        code = inbox.process(results, idemkey)
        emit(results[idemkey], "recovered")
        if code != EXIT_OK:
            worst = code
    return worst


def cmd_get(inbox: Inbox, idemkey: str) -> int:
    results = inbox.load_results()
    if idemkey not in results:
        raise InvalidInputError(f"unknown idemkey: {idemkey}")
    record = results[idemkey]
    print(
        json.dumps(
            {
                "idemkey": record["idemkey"],
                "status": record["status"],
                "result": record["result"],
                "attempts": record["attempts"],
            },
            sort_keys=True,
        )
    )
    return EXIT_OK


def main(argv: list[str]) -> int:
    args = list(argv)
    directory = os.environ.get("INBOX_DIR", "./inbox")
    if "--dir" in args:
        idx = args.index("--dir")
        try:
            directory = args[idx + 1]
        except IndexError:
            raise InvalidInputError("--dir requires a value")
        del args[idx : idx + 2]
    if not args:
        raise InvalidInputError(
            "usage: inbox.py [--dir DIR] "
            "{enqueue TASK_JSON | run-once [IDEMKEY] | "
            "crash --after CLAIM IDEMKEY | recover | get IDEMKEY}"
        )
    inbox = Inbox(directory)
    command, rest = args[0], args[1:]
    if command == "enqueue" and len(rest) == 1:
        return cmd_enqueue(inbox, rest[0])
    if command == "run-once" and len(rest) <= 1:
        return cmd_run_once(inbox, rest[0] if rest else None)
    if command == "crash" and len(rest) == 3 and rest[0] == "--after" and rest[1] == CLAIM_TOKEN:
        return cmd_crash(inbox, rest[2])
    if command == "recover" and not rest:
        return cmd_recover(inbox)
    if command == "get" and len(rest) == 1:
        return cmd_get(inbox, rest[0])
    raise InvalidInputError(f"invalid arguments: {' '.join(argv)}")


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except InvalidInputError as exc:
        print(f"error: invalid input: {exc}", file=sys.stderr)
        sys.exit(EXIT_INVALID_INPUT)
    except CorruptStorageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(EXIT_STORAGE_CORRUPT)
