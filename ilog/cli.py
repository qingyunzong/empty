"""Command line interface: python -m ilog.cli [-f FILE] <add|remove|compact|commit|list>.

add/remove apply to the in-memory working state and are then committed;
compact merges adjacent intervals through the same commit flow.  Errors are
reported with a machine-readable code and exit status 2.
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import BAD_INTERVAL, ILogError, IntervalStore


def _parse_number(text):
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        raise ILogError(BAD_INTERVAL, "not a number: %r" % text)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="python -m ilog.cli",
        description="Persist a set of half-open intervals to a single JSON file.",
    )
    parser.add_argument(
        "-f", "--file", default="ilog.json",
        help="path to the JSON state file (default: ilog.json)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("add", "remove"):
        cmd = sub.add_parser(name, help="%s the half-open interval [lo, hi)" % name)
        cmd.add_argument("lo")
        cmd.add_argument("hi")
    sub.add_parser("compact", help="merge adjacent intervals and commit")
    sub.add_parser("commit", help="persist the current state")
    sub.add_parser("list", help="load (recovering if needed) and print the state")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        store = IntervalStore(args.file)
        if args.command == "add":
            store.add(_parse_number(args.lo), _parse_number(args.hi))
            store.commit()
        elif args.command == "remove":
            store.remove(_parse_number(args.lo), _parse_number(args.hi))
            store.commit()
        elif args.command == "compact":
            store.compact()
        elif args.command == "commit":
            store.commit()
    except ILogError as exc:
        print("error[%s]: %s" % (exc.code, exc.message), file=sys.stderr)
        return 2
    result = {
        "intervals": [[lo, hi] for lo, hi in store.intervals()],
        "recovered": store.recovered,
    }
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
