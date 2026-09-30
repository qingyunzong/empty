"""CLI: python -m safedelsync sync L R --state S"""
from __future__ import annotations

import argparse
import json
import sys

from . import StateCorruptError, sync_dirs


def main(argv=None):
    parser = argparse.ArgumentParser(prog="safedelsync")
    sub = parser.add_subparsers(dest="command", required=True)
    sync_parser = sub.add_parser("sync", help="synchronize two directories")
    sync_parser.add_argument("left", help="left directory")
    sync_parser.add_argument("right", help="right directory")
    sync_parser.add_argument("--state", required=True, help="state file path")
    args = parser.parse_args(argv)

    if args.command == "sync":
        try:
            stats = sync_dirs(args.left, args.right, args.state)
        except StateCorruptError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 4
        except OSError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print(json.dumps(stats, sort_keys=True))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
