#!/usr/bin/env python3
"""Crash-recoverable JSONL record processor.

Reads JSONL records, writes one atomic JSON output file per record id into an
output directory, and maintains a checkpoint (max processed sequence number)
plus a state machine: RUNNING -> RECOVERING -> COMPLETED / FAILED.

Commands: process, crash --at POINT, recover, dead-letters, state.
Crash points: AFTER_READ, AFTER_WRITE, AFTER_CHECKPOINT.
"""
import argparse
import json
import os
import sys
import tempfile
import zlib

STATE_FILE = "state.json"
DEAD_LETTER_FILE = "dead_letters.jsonl"
CRASH_POINTS = ("AFTER_READ", "AFTER_WRITE", "AFTER_CHECKPOINT")
MAX_ATTEMPTS = 3
STATES = ("RUNNING", "RECOVERING", "COMPLETED", "FAILED")

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CRASH = 2


class PipelineError(Exception):
    """Explicit, expected pipeline failure (bad paths, bad state, ...)."""


class SimulatedCrash(Exception):
    """Raised by the `crash` command to simulate a hard crash (no cleanup)."""

    def __init__(self, point, seq):
        self.point = point
        self.seq = seq
        super().__init__(f"simulated crash at {point} (seq={seq})")


def transform(rid, name, seq):
    """Keep only id, name length and checksum (plus seq for order checks)."""
    return {
        "id": rid,
        "seq": seq,
        "name_length": len(name),
        "checksum": zlib.crc32(name.encode("utf-8")),
    }


def atomic_write_json(path, obj):
    """Write JSON via a temp file in the same directory + os.replace."""
    directory = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(obj, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def state_path(outdir):
    return os.path.join(outdir, STATE_FILE)


def output_path(outdir, rid):
    return os.path.join(outdir, rid + ".json")


def dead_letter_path(outdir):
    return os.path.join(outdir, DEAD_LETTER_FILE)


def load_state(outdir):
    path = state_path(outdir)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise PipelineError(f"cannot read state file {path}: {exc}") from exc
    if not isinstance(state, dict) or state.get("state") not in STATES:
        raise PipelineError(f"corrupt state file {path}: unknown state")
    return state


def save_state(outdir, state):
    atomic_write_json(state_path(outdir), state)


def scan_output_ids(outdir):
    """Ids that already have a committed output file in outdir."""
    ids = set()
    for name in os.listdir(outdir):
        if name.endswith(".json") and name != STATE_FILE and not name.startswith(".tmp-"):
            ids.add(name[: -len(".json")])
    return ids


def append_dead_letter(outdir, entry):
    path = dead_letter_path(outdir)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def validate_record(record):
    """Return (rid, name) or raise ValueError describing the problem."""
    if not isinstance(record, dict):
        raise ValueError("record is not a JSON object")
    rid = record.get("id")
    if isinstance(rid, bool) or not isinstance(rid, (str, int)):
        raise ValueError("record missing valid 'id'")
    rid = str(rid)
    if not rid or rid in (".", "..") or "/" in rid or "\\" in rid or os.sep in rid:
        raise ValueError(f"unsafe record id: {rid!r}")
    name = record.get("name")
    if not isinstance(name, str):
        raise ValueError("record missing 'name'")
    return rid, name


def transform_with_retries(record, seq):
    """Return (rid, output, error). Retries validation MAX_ATTEMPTS times."""
    last_error = None
    for _attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            rid, name = validate_record(record)
            return rid, transform(rid, name, seq), None
        except ValueError as exc:
            last_error = exc
    return None, None, str(last_error)


def check_paths(input_path, outdir):
    if os.path.exists(outdir) and not os.path.isdir(outdir):
        raise PipelineError(f"output path exists and is not a directory: {outdir}")
    os.makedirs(outdir, exist_ok=True)
    if not os.path.exists(input_path):
        raise PipelineError(f"input file not found: {input_path}")
    if not os.path.isfile(input_path):
        raise PipelineError(f"input path is not a file: {input_path}")


def execute(input_path, outdir, crash_point=None, crash_seq=0, recovering=False):
    """Run (or resume) the pipeline. Returns the final state dict."""
    check_paths(input_path, outdir)

    state = load_state(outdir)
    if recovering:
        if state is None:
            raise PipelineError(f"no state file in {outdir}: nothing to recover")
        if state["state"] == "COMPLETED":
            raise PipelineError("pipeline already COMPLETED: nothing to recover")
        state["state"] = "RECOVERING"
        state["error"] = None
    else:
        if state is not None:
            raise PipelineError(
                f"state file already exists in {outdir}: use 'recover' to resume"
            )
        state = {"state": "RUNNING", "checkpoint": -1, "duplicates": [], "error": None}
    save_state(outdir, state)

    # Recovery: scan committed outputs first, then consult the checkpoint.
    checkpoint = state["checkpoint"]
    preexisting = scan_output_ids(outdir)
    resume_seq = checkpoint + 1
    seen = set()

    try:
        with open(input_path, encoding="utf-8") as handle:
            for seq, raw_line in enumerate(handle):
                line = raw_line.strip()
                if not line:
                    continue
                if seq <= checkpoint:
                    continue

                if crash_point == "AFTER_READ" and seq == crash_seq:
                    raise SimulatedCrash(crash_point, seq)

                try:
                    record = json.loads(line)
                    parse_error = None
                except json.JSONDecodeError as exc:
                    record = None
                    parse_error = f"invalid JSON: {exc}"

                if parse_error is not None:
                    rid, output, error = None, None, parse_error
                else:
                    rid, output, error = transform_with_retries(record, seq)

                if error is not None:
                    append_dead_letter(outdir, {
                        "seq": seq,
                        "line": line,
                        "reason": error,
                        "attempts": MAX_ATTEMPTS,
                    })
                elif rid in seen:
                    # Duplicate id: first occurrence wins, later ones are logged.
                    state["duplicates"].append({"seq": seq, "id": rid})
                elif rid in preexisting:
                    # A committed output for the exact record we crashed on
                    # (AFTER_WRITE) is a leftover: adopt it, do NOT rewrite.
                    # Anything else is a duplicate of an earlier record.
                    leftover = False
                    if seq == resume_seq:
                        try:
                            with open(output_path(outdir, rid),
                                      encoding="utf-8") as existing:
                                leftover = json.load(existing) == output
                        except (OSError, json.JSONDecodeError):
                            leftover = False
                    if leftover:
                        seen.add(rid)
                    else:
                        state["duplicates"].append({"seq": seq, "id": rid})
                else:
                    atomic_write_json(output_path(outdir, rid), output)
                    if crash_point == "AFTER_WRITE" and seq == crash_seq:
                        raise SimulatedCrash(crash_point, seq)
                    seen.add(rid)

                checkpoint = seq
                state["checkpoint"] = checkpoint
                save_state(outdir, state)
                if crash_point == "AFTER_CHECKPOINT" and seq == crash_seq:
                    raise SimulatedCrash(crash_point, seq)
    except OSError as exc:
        raise PipelineError(f"cannot read input file {input_path}: {exc}") from exc

    state["state"] = "COMPLETED"
    state["checkpoint"] = checkpoint
    save_state(outdir, state)
    return state


def mark_failed(outdir, message):
    """Best-effort: persist FAILED state with an explicit error message."""
    try:
        if not os.path.isdir(outdir):
            return
        state = load_state(outdir)
        if state is None:
            state = {"state": "FAILED", "checkpoint": -1, "duplicates": [], "error": None}
        if state.get("state") != "COMPLETED":
            state["state"] = "FAILED"
            state["error"] = message
            save_state(outdir, state)
    except Exception:
        pass


def cmd_process(args):
    state = execute(args.input, args.outdir)
    print(json.dumps(state, ensure_ascii=False, sort_keys=True))
    return EXIT_OK


def cmd_crash(args):
    try:
        execute(args.input, args.outdir, crash_point=args.at, crash_seq=args.seq)
    except SimulatedCrash as crash:
        print(f"CRASH: {crash}", file=sys.stderr)
        return EXIT_CRASH
    print("no crash triggered (crash point never reached)", file=sys.stderr)
    return EXIT_ERROR


def cmd_recover(args):
    state = execute(args.input, args.outdir, recovering=True)
    print(json.dumps(state, ensure_ascii=False, sort_keys=True))
    return EXIT_OK


def cmd_dead_letters(args):
    if not os.path.isdir(args.outdir):
        raise PipelineError(f"output directory not found: {args.outdir}")
    entries = []
    path = dead_letter_path(args.outdir)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            entries = [json.loads(line) for line in handle if line.strip()]
    print(json.dumps(entries, ensure_ascii=False, indent=2, sort_keys=True))
    return EXIT_OK


def cmd_state(args):
    if not os.path.isdir(args.outdir):
        raise PipelineError(f"output directory not found: {args.outdir}")
    state = load_state(args.outdir)
    if state is None:
        raise PipelineError(f"no state file in {args.outdir}")
    print(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True))
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(
        prog="pipeline",
        description="Crash-recoverable JSONL processor with atomic outputs "
        "and checkpoints.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_io(p):
        p.add_argument("--input", required=True, help="input JSONL file")
        p.add_argument("--outdir", required=True, help="output directory")

    add_io(sub.add_parser("process", help="process all records from scratch"))

    crash = sub.add_parser("crash", help="process, then simulate a crash")
    add_io(crash)
    crash.add_argument("--at", required=True, choices=CRASH_POINTS,
                       help="crash point")
    crash.add_argument("--seq", type=int, default=0,
                       help="record sequence number at which to crash")

    add_io(sub.add_parser("recover", help="resume after a crash/failure"))

    dead = sub.add_parser("dead-letters", help="list dead-lettered records")
    dead.add_argument("--outdir", required=True)

    state = sub.add_parser("state", help="print current pipeline state")
    state.add_argument("--outdir", required=True)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    handlers = {
        "process": cmd_process,
        "crash": cmd_crash,
        "recover": cmd_recover,
        "dead-letters": cmd_dead_letters,
        "state": cmd_state,
    }
    try:
        return handlers[args.command](args)
    except PipelineError as exc:
        if getattr(args, "outdir", None):
            mark_failed(args.outdir, str(exc))
        print(f"ERROR: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
