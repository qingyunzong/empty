"""Command line interface.

Usage:
    python -m kvstore run script.json [--inject faults.json] [--replay] [--db PATH]

The script is a JSON list of steps:
    {"op": "begin"}                     open a nested transaction (max depth 3)
    {"op": "put", "key": k, "value": v} write into the current transaction
    {"op": "del", "key": k}             delete in the current transaction
    {"op": "commit"}                    commit the innermost transaction
    {"op": "rollback"}                  abort the innermost transaction
    {"op": "view"}                      no-op, only prints the current view

faults.json is a JSON list of fault-point names (append_before,
append_after, fsync_fail, crash_after_commit); each fires once.

One JSON object is printed per step, including the visible view after the
step. Step-level E_TXN / E_IO errors are reported in the step output and
the run continues. Infrastructure failures (bad script, E_CORRUPT log,
injected crash) exit with status 3.
"""

import argparse
import json
import sys

from .errors import CorruptError, CrashFault, KVError, TxnError
from .store import FAULT_POINTS, Store

EXIT_FAILURE = 3


def _load_json_file(path, what):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as exc:
        raise KVError("cannot read %s %s: %s" % (what, path, exc))
    except ValueError as exc:
        raise KVError("invalid JSON in %s %s: %s" % (what, path, exc))


def _load_faults(path):
    data = _load_json_file(path, "faults file")
    if isinstance(data, dict):
        if "points" in data:
            data = data["points"]
        else:
            data = [name for name, enabled in data.items() if enabled]
    if not isinstance(data, list) or not all(isinstance(p, str) for p in data):
        raise KVError("faults file must be a JSON list of fault point names")
    unknown = set(data) - set(FAULT_POINTS)
    if unknown:
        raise KVError("unknown fault point(s): %s" % ", ".join(sorted(unknown)))
    return data


def _emit(line):
    print(json.dumps(line, sort_keys=True))


def _run_step(store, step):
    if not isinstance(step, dict):
        raise TxnError("script step must be an object")
    op = step.get("op")
    if op == "begin":
        store.begin()
    elif op == "put":
        if "key" not in step:
            raise TxnError("put step requires a key")
        store.put(step["key"], step.get("value"))
    elif op == "del":
        if "key" not in step:
            raise TxnError("del step requires a key")
        store.delete(step["key"])
    elif op == "commit":
        store.commit()
    elif op == "rollback":
        store.rollback()
    elif op == "view":
        pass
    else:
        raise TxnError("unknown op: %r" % (op,))
    return op


def run_command(args):
    try:
        steps = _load_json_file(args.script, "script file")
        if not isinstance(steps, list):
            raise KVError("script file must contain a JSON list of steps")
        faults = _load_faults(args.inject) if args.inject else []
        if args.replay:
            store = Store.recover(args.db, faults)
        else:
            store = Store.create(args.db, faults)
    except KVError as exc:
        _emit({"status": "error", "code": exc.code, "message": str(exc)})
        return EXIT_FAILURE

    for index, step in enumerate(steps):
        op = step.get("op") if isinstance(step, dict) else None
        try:
            op = _run_step(store, step)
        except CrashFault as crash:
            _emit({"step": index, "op": op, "status": "crash", "point": crash.point})
            return EXIT_FAILURE
        except KVError as exc:
            _emit({
                "step": index,
                "op": op,
                "status": "error",
                "code": exc.code,
                "message": str(exc),
                "view": store.view(),
            })
            continue
        _emit({"step": index, "op": op, "status": "ok", "view": store.view()})
    store.close()
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kvstore")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a script against the log store")
    run.add_argument("script", help="path to script JSON file")
    run.add_argument("--inject", metavar="FAULTS", help="path to faults JSON file")
    run.add_argument("--replay", action="store_true",
                     help="recover and replay the existing log before running")
    run.add_argument("--db", default="kvstore.db", help="log file path")
    args = parser.parse_args(argv)
    if args.command == "run":
        return run_command(args)
    parser.error("unknown command")


if __name__ == "__main__":
    sys.exit(main())
