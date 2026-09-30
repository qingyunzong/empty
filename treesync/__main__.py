"""CLI: python -m treesync sync SRC DST [--state STATE]"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .core import ConflictError, DEFAULT_STATE_NAME, SyncError, sync

EXIT_OK = 0
EXIT_ERROR = 2
EXIT_CONFLICT = 4


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="treesync", description="One-way sync of small file trees."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_sync = sub.add_parser("sync", help="sync SRC into DST (one way)")
    p_sync.add_argument("src", help="source tree")
    p_sync.add_argument("dst", help="destination tree")
    p_sync.add_argument(
        "--state",
        default=None,
        help="state file path (default: DST/%s)" % DEFAULT_STATE_NAME,
    )
    args = parser.parse_args(argv)

    state = args.state or os.path.join(args.dst, DEFAULT_STATE_NAME)
    try:
        report = sync(args.src, args.dst, state)
    except ConflictError as exc:
        output = {
            "plan": None,
            "result": {"status": "conflict", "conflicts": exc.conflicts},
        }
        json.dump(output, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        for path in exc.conflicts:
            print(
                "treesync: conflict: foreign entry in destination: %s" % path,
                file=sys.stderr,
            )
        return EXIT_CONFLICT
    except SyncError as exc:
        print("treesync: error: %s" % exc, file=sys.stderr)
        return EXIT_ERROR

    output = {
        "plan": {
            "op_count": len(report["ops"]),
            "batches": report["batches"],
            "ops": report["ops"],
        },
        "result": {
            "status": "ok",
            "applied": report["applied"],
            "resumed_from_journal": report["resumed"],
            "cleaned_temp": report["cleaned_temp"],
            "state": os.path.abspath(state),
        },
    }
    json.dump(output, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
