"""CLI: python -m snapsync compact LOG SNAP --keep K"""
from __future__ import annotations

import argparse
import json
import sys

from . import core


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="snapsync",
        description="Compact an operation log against a consistent snapshot.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    compact = sub.add_parser("compact", help="truncate LOG at SNAP and prune old snapshots")
    compact.add_argument("log", help="path to the JSONL operation log")
    compact.add_argument("snap", help="path to the current snapshot JSON file")
    compact.add_argument(
        "--keep",
        type=int,
        default=3,
        help="number of most recent snapshots to keep (current counts as one; 0 => 1)",
    )
    args = parser.parse_args(argv)

    if args.command == "compact":
        try:
            result = core.compact(args.log, args.snap, keep=args.keep)
        except core.LogIntegrityError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return core.EXIT_LOG_CORRUPT
        except core.SnapshotCorruptError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return core.EXIT_SNAPSHOT_CORRUPT
        except OSError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return core.EXIT_USAGE
        print(json.dumps(result, sort_keys=True))
        return core.EXIT_OK
    return core.EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
