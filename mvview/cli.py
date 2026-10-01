"""JSON command-line interface for the incremental materialized view.

Usage:
  python3.11 -m mvview --state DIR apply [ops.json|-]
  python3.11 -m mvview --state DIR view
  python3.11 -m mvview --state DIR checkpoint
  python3.11 -m mvview --state DIR recover
  python3.11 -m mvview --state DIR rank GROUP VALUE
  python3.11 -m mvview --state DIR select GROUP K

`apply` reads a JSON array of ops (or {"ops": [...]}) and applies it as one
atomic batch.  Every command prints a single JSON object on stdout; a
rejected batch prints {"ok": false, "error": ...} and exits with status 1.
"""

import argparse
import json
import sys

from .engine import BatchError, Engine
from .jsonnum import num_from_json, num_to_json


def _parse_scalar(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _emit(payload):
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="mvview",
        description="Incremental equi-join group-by materialized view")
    parser.add_argument("--state", required=True,
                        help="state directory holding wal.log and checkpoint")
    sub = parser.add_subparsers(dest="command", required=True)

    p_apply = sub.add_parser("apply", help="apply one atomic batch of ops")
    p_apply.add_argument("file", nargs="?", default="-",
                         help="JSON file with the ops array, or '-' for stdin")
    sub.add_parser("view", help="print the current materialized view")
    sub.add_parser("checkpoint", help="write a checkpoint snapshot")
    sub.add_parser("recover", help="re-run recovery and report the version")
    p_rank = sub.add_parser("rank", help="rank of VALUE within GROUP")
    p_rank.add_argument("group")
    p_rank.add_argument("value")
    p_select = sub.add_parser("select",
                              help="k-th smallest value (0-based) in GROUP")
    p_select.add_argument("group")
    p_select.add_argument("k", type=int)

    args = parser.parse_args(argv)
    engine = Engine.open(args.state)

    try:
        if args.command == "apply":
            if args.file == "-":
                text = sys.stdin.read()
            else:
                with open(args.file, encoding="utf-8") as fh:
                    text = fh.read()
            payload = json.loads(text)
            ops = payload["ops"] if isinstance(payload, dict) else payload
            if not isinstance(ops, list):
                raise BatchError("batch must be a JSON array of ops")
            version = engine.apply_batch(ops)
            _emit({"ok": True, "version": version})
        elif args.command == "view":
            _emit(engine.view_json())
        elif args.command == "checkpoint":
            engine.checkpoint()
            _emit({"ok": True, "version": engine.version})
        elif args.command == "recover":
            _emit({"ok": True, "version": engine.version})
        elif args.command == "rank":
            group = _parse_scalar(args.group)
            value = num_from_json(_parse_scalar(args.value))
            _emit({"ok": True, "group": group, "value": num_to_json(value),
                   "rank": engine.rank(group, value)})
        elif args.command == "select":
            group = _parse_scalar(args.group)
            _emit({"ok": True, "group": group, "k": args.k,
                   "value": num_to_json(engine.select(group, args.k))})
    except BatchError as exc:
        _emit({"ok": False, "error": str(exc)})
        raise SystemExit(1)
    except (json.JSONDecodeError, ValueError, KeyError) as exc:
        _emit({"ok": False, "error": f"bad input: {exc}"})
        raise SystemExit(2)


if __name__ == "__main__":
    main()
