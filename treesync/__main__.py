"""CLI: python -m treesync sync SRC DST [--state STATE]

Exit codes: 0 ok, 2 usage/input error, 4 conflict, 1 unexpected error.
The plan and result are printed to stdout as JSON; errors go to stderr.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import core


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="treesync")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("sync", help="one-way sync SRC onto DST")
    p.add_argument("src", help="source tree")
    p.add_argument("dst", help="destination tree")
    p.add_argument(
        "--state",
        default=None,
        help="state file path (default: <dst>/%s)" % core.STATE_DEFAULT_NAME,
    )
    args = parser.parse_args(argv)

    if args.command == "sync":
        try:
            report = core.sync(args.src, args.dst, args.state)
        except core.ConflictError as exc:
            print(
                json.dumps(
                    {"status": "conflict", "conflicts": exc.conflicts},
                    indent=2,
                    sort_keys=True,
                )
            )
            print("treesync: %s" % exc, file=sys.stderr)
            return 4
        except (FileNotFoundError, ValueError) as exc:
            print("treesync: error: %s" % exc, file=sys.stderr)
            return 2
        except OSError as exc:
            print("treesync: error: %s" % exc, file=sys.stderr)
            return 1
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    parser.error("unknown command")  # pragma: no cover
    return 2


if __name__ == "__main__":
    sys.exit(main())
