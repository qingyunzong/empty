"""CLI: python -m hierosync commit ROOT SNAP [--undo N]"""

from __future__ import annotations

import argparse
import json
import sys

from . import core


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hierosync",
        description="Hierarchical directory snapshot versioning.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    commit = sub.add_parser("commit", help="commit a snapshot, optionally undoing commits")
    commit.add_argument("root", help="target subtree root (inside the repository)")
    commit.add_argument("snap", help="snapshot store directory (directly inside repo root)")
    commit.add_argument(
        "--undo",
        type=int,
        default=0,
        metavar="N",
        help="roll back the most recent N commits inside ROOT",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.undo < 0:
        print("error: --undo must be >= 0", file=sys.stderr)
        return core.EXIT_ERROR
    try:
        result = core.commit(args.root, args.snap, undo=args.undo)
    except core.CorruptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return core.EXIT_CORRUPT
    except core.HierosyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return core.EXIT_ERROR
    print(json.dumps(result, sort_keys=True))
    return core.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
