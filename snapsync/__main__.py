"""Command line interface for snapsync.

Usage:
    python -m snapsync compact LOG SNAP --keep K
    python -m snapsync restore LOG SNAP

Success prints a JSON object on stdout; errors go to stderr.
Exit codes: 0 ok, 2 log/IO/usage error, 8 corrupt/mismatched snapshot.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import (
    EXIT_LOG_ERROR,
    EXIT_OK,
    EXIT_SNAPSHOT_CORRUPT,
    LogError,
    SnapshotError,
    compact,
    restore,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="snapsync",
        description="Compact an operation log into snapshots and restore state.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_compact = sub.add_parser(
        "compact", help="fold LOG into a new snapshot generation and truncate it"
    )
    p_compact.add_argument("log", help="path to the operation log (JSON Lines)")
    p_compact.add_argument("snap", help="path to the current snapshot file")
    p_compact.add_argument(
        "--keep",
        type=int,
        default=3,
        help="number of recent snapshot generations to keep (min 1; default 3)",
    )

    p_restore = sub.add_parser(
        "restore", help="rebuild the state hash from SNAP plus the LOG suffix"
    )
    p_restore.add_argument("log", help="path to the operation log (JSON Lines)")
    p_restore.add_argument("snap", help="path to the current snapshot file")
    return parser


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "compact":
            result = compact(args.log, args.snap, args.keep)
        else:
            result = {"restored_hash": restore(args.log, args.snap)}
    except SnapshotError as exc:
        print(f"snapsync: error: {exc}", file=sys.stderr)
        return EXIT_SNAPSHOT_CORRUPT
    except (LogError, OSError) as exc:
        print(f"snapsync: error: {exc}", file=sys.stderr)
        return EXIT_LOG_ERROR
    print(json.dumps(result, sort_keys=True))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
