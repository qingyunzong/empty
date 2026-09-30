"""Command line interface: python -m hierosync commit ROOT SNAP [--undo N].

Prints a JSON object with committed/undone/skipped on stdout; errors go
to stderr.  Exit codes: 0 ok, 2 usage error, 5 store corruption.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import core


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hierosync",
        description="Maintain hierarchical version snapshots of a directory tree.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    commit = sub.add_parser(
        "commit", help="snapshot ROOT into SNAP, optionally undoing recent commits"
    )
    commit.add_argument("root", metavar="ROOT", help="root of the directory tree")
    commit.add_argument("snap", metavar="SNAP", help="snapshot store directory")
    commit.add_argument(
        "--undo",
        type=int,
        default=0,
        metavar="N",
        help="roll back the in-subtree changes of the most recent N commits",
    )
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "commit":
        if args.undo < 0:
            parser.error("--undo must be >= 0")
        try:
            result = core.commit(args.root, args.snap, args.undo)
        except core.CorruptionError as exc:
            print(f"hierosync: corruption: {exc}", file=sys.stderr)
            return core.EXIT_CORRUPTION
        except core.UsageError as exc:
            print(f"hierosync: error: {exc}", file=sys.stderr)
            return core.EXIT_USAGE
        print(json.dumps(result, sort_keys=True))
        return core.EXIT_OK
    parser.error("unknown command")  # pragma: no cover
    return core.EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
