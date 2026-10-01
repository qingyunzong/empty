"""Command line interface: python -m dpor explore program.json ..."""

import argparse
import json
import sys

from .model import ProgramError, validate_program
from .explorer import Explorer


def _load_program(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        raise ProgramError("cannot read %s: %s" % (path, exc))
    except json.JSONDecodeError as exc:
        raise ProgramError("invalid JSON in %s: %s" % (path, exc))
    return validate_program(data)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="dpor",
        description="Dynamic partial-order reduction explorer.")
    sub = parser.add_subparsers(dest="command", required=True)
    explore = sub.add_parser("explore", help="explore a program with DPOR")
    explore.add_argument("program", help="path to the program JSON file")
    explore.add_argument("--max-schedules", type=int, default=5000,
                         help="stop after this many schedules (default 5000)")
    explore.add_argument("--out", help="write the JSON report to this file")
    args = parser.parse_args(argv)

    if args.command == "explore":
        try:
            program = _load_program(args.program)
        except ProgramError as exc:
            print("error: %s" % exc, file=sys.stderr)
            return 2
        if args.max_schedules < 1:
            print("error: --max-schedules must be >= 1", file=sys.stderr)
            return 2
        report = Explorer(program, max_schedules=args.max_schedules).run().report()
        text = json.dumps(report, indent=2)
        if args.out:
            try:
                with open(args.out, "w", encoding="utf-8") as handle:
                    handle.write(text + "\n")
            except OSError as exc:
                print("error: cannot write %s: %s" % (args.out, exc),
                      file=sys.stderr)
                return 2
        print(text)
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
