"""Command line interface: python -m fairq run events.json --out result.json --log log.txt"""

from __future__ import annotations

import argparse
import json
import sys

from .simulator import DEFAULT_WINDOW, SimError, normalize_events, simulate


def _fail(message: str) -> int:
    print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
    return 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="fairq",
        description="Deterministic weighted-DRF flow scheduler simulator.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a simulation from an events JSON file")
    run.add_argument("events", help="path to the events JSON file")
    run.add_argument("--out", help="write result JSON here (default: stdout)")
    run.add_argument("--log", help="write the deterministic event log here")
    run.add_argument(
        "--window",
        type=int,
        default=DEFAULT_WINDOW,
        help="starvation window W (default: %(default)s)",
    )
    args = parser.parse_args(argv)

    if args.command == "run":
        try:
            with open(args.events, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except OSError as exc:
            return _fail(f"cannot read events file: {exc}")
        except json.JSONDecodeError as exc:
            return _fail(f"invalid JSON: {exc}")
        try:
            events = normalize_events(raw)
            result, log_lines = simulate(events, window=args.window)
        except SimError as exc:
            return _fail(str(exc))

        out_text = json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        if args.out:
            try:
                with open(args.out, "w", encoding="utf-8") as handle:
                    handle.write(out_text)
            except OSError as exc:
                return _fail(f"cannot write result: {exc}")
        else:
            sys.stdout.write(out_text)
        if args.log:
            try:
                with open(args.log, "w", encoding="utf-8") as handle:
                    handle.write("\n".join(log_lines) + "\n")
            except OSError as exc:
                return _fail(f"cannot write log: {exc}")
        return 0
    return 2
