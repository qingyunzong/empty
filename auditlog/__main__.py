"""CLI: python -m auditlog append|verify|replay|snapshot"""

from __future__ import annotations

import argparse
import json
import sys

from .core import AuditLog, PolicyError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="auditlog")
    parser.add_argument("--dir", default=".",
                        help="log directory (default: current directory)")
    parser.add_argument("--snapshot-every", type=int, default=10,
                        help="write a snapshot every N appends (0=never)")
    sub = parser.add_subparsers(dest="command", required=True)
    p_append = sub.add_parser("append", help="append key=value records")
    p_append.add_argument("payloads", nargs="+", metavar="KEY=VALUE")
    sub.add_parser("verify", help="verify the hash chain")
    sub.add_parser("replay", help="replay records and print the state as JSON")
    sub.add_parser("snapshot", help="force a snapshot now")
    args = parser.parse_args(argv)

    try:
        log = AuditLog(args.dir, snapshot_every=args.snapshot_every)
        if args.command == "append":
            for payload in args.payloads:
                log.append(payload.encode("utf-8"))
            print(f"appended {len(args.payloads)} record(s)")
        elif args.command == "verify":
            print(f"OK: {log.verify()} record(s)")
        elif args.command == "replay":
            print(json.dumps(log.replay(), sort_keys=True))
        elif args.command == "snapshot":
            log.snapshot()
            print("snapshot written")
    except PolicyError as exc:
        location = f" at offset {exc.offset}" if exc.offset is not None else ""
        print(f"error[{exc.code}]: {exc}{location}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
