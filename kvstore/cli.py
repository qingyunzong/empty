"""CLI: python -m kvstore run script.json [--inject faults.json] [--replay] [--log PATH]

Prints one JSON line per executed step with the visible view, e.g.
    {"step": 0, "op": "begin", "ok": true, "view": {}}
On a step error the line carries "ok": false and an error code
(E_TXN, E_IO, E_CORRUPT). With --replay a final
    {"event": "replay", "view": {...}, "corrupt_tail_truncated": false}
line is printed after recovering the log. Any failure exits with code 3.
"""

from __future__ import annotations

import argparse
import json
import sys

from .errors import CrashSimulation, KVError, TxnError
from .faults import FaultInjector
from .store import Store, recover

EXIT_FAILURE = 3


def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _execute(store, step):
    if not isinstance(step, dict):
        raise TxnError("step must be an object")
    op = step.get("op")
    try:
        if op == "begin":
            store.begin()
        elif op == "put":
            store.put(step["key"], step["value"])
        elif op == "del":
            store.delete(step["key"])
        elif op == "commit":
            store.commit()
        elif op == "rollback":
            store.rollback()
        else:
            raise TxnError(f"unknown op: {op!r}")
    except KeyError as exc:
        raise TxnError(f"missing field {exc} for op {op!r}") from exc


def _emit(obj):
    print(json.dumps(obj, sort_keys=True))


def _run(args):
    try:
        script = _load_json(args.script)
        spec = _load_json(args.inject) if args.inject else {}
        injector = FaultInjector(spec)
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": "E_IO", "message": str(exc)}), file=sys.stderr)
        return EXIT_FAILURE

    steps = script.get("steps") if isinstance(script, dict) else script
    if not isinstance(steps, list):
        print(json.dumps({"error": "E_TXN", "message": "script must be a list of steps"}),
              file=sys.stderr)
        return EXIT_FAILURE

    log_path = args.log or (args.script + ".log")
    exit_code = 0

    with Store(log_path, injector) as store:
        for i, step in enumerate(steps):
            injector.step = i
            op = step.get("op") if isinstance(step, dict) else None
            try:
                _execute(store, step)
            except CrashSimulation:
                _emit({"step": i, "op": op, "ok": True, "view": store.view()})
                _emit({"event": "crash", "step": i})
                exit_code = EXIT_FAILURE
                break
            except KVError as exc:
                _emit({"step": i, "op": op, "ok": False, "error": exc.code,
                       "message": str(exc), "view": store.view()})
                exit_code = EXIT_FAILURE
                continue
            _emit({"step": i, "op": op, "ok": True, "view": store.view()})

    if args.replay:
        view, truncated = recover(log_path)
        if truncated:
            print(json.dumps({"event": "corrupt_tail_truncated", "error": "E_CORRUPT"}),
                  file=sys.stderr)
        _emit({"event": "replay", "view": view, "corrupt_tail_truncated": truncated})

    return exit_code


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kvstore")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="execute a script against the log store")
    run.add_argument("script", help="JSON file with a list of steps (or {'steps': [...]})")
    run.add_argument("--inject", help="JSON file with fault injection spec")
    run.add_argument("--replay", action="store_true",
                     help="recover the log after the run and print the replayed view")
    run.add_argument("--log", help="path of the log file (default: <script>.log)")
    args = parser.parse_args(argv)
    return _run(args)
