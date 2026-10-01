"""Command line interface: python -m fairq run events.json --out r.json --log l.txt"""

from __future__ import annotations

import argparse
import json
import sys

from .simulator import SimError, simulate


def _emit_error(payload):
    sys.stderr.write(json.dumps(payload, sort_keys=True) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="fairq",
        description="Deterministic fair-queueing simulator (weighted DRF).",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a simulation over an events JSON file")
    run.add_argument("input", help="path to the events JSON file")
    run.add_argument("--out", help="write the result JSON here (default: stdout)")
    run.add_argument("--log", help="write the deterministic service log here")
    args = parser.parse_args(argv)

    try:
        with open(args.input, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except OSError as exc:
        _emit_error(
            {"error": "cannot read %s: %s" % (args.input, exc.strerror or exc),
             "code": "input_unreadable"}
        )
        return 2
    except json.JSONDecodeError as exc:
        _emit_error({"error": "invalid JSON: %s" % exc, "code": "invalid_json"})
        return 2

    try:
        result, log_lines = simulate(raw)
    except SimError as exc:
        _emit_error(exc.to_dict())
        return 2

    text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    if args.log:
        with open(args.log, "w", encoding="utf-8") as fh:
            fh.write("\n".join(log_lines) + "\n")
    return 0
