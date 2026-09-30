"""Command line interface: ``python -m safedelsync sync L R --state S``."""

from __future__ import annotations

import argparse
import json
import sys

from . import core

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_STATE_CORRUPT = 4


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="safedelsync",
        description="Safely synchronize two directories in both directions.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    sync_parser = subparsers.add_parser(
        "sync", help="Synchronize directories LEFT and RIGHT."
    )
    sync_parser.add_argument("left", help="left directory")
    sync_parser.add_argument("right", help="right directory")
    sync_parser.add_argument(
        "--state", required=True, help="path to the sync state file"
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "sync":
        try:
            stats = core.sync(args.left, args.right, args.state)
        except core.StateError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_STATE_CORRUPT
        except OSError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        print(json.dumps(stats, sort_keys=True))
        return EXIT_OK
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
