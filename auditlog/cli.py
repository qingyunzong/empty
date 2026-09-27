"""Command line interface: python -m auditlog append/verify/replay/snapshot."""

from __future__ import annotations

import argparse
import json
import sys

from .core import PolicyError, append, replay, snapshot, verify


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="auditlog", description="append-only audit log")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add_dir(p):
        p.add_argument("--dir", default="auditlog.d", help="log directory")

    p_append = sub.add_parser("append", help="append one record")
    add_dir(p_append)
    p_append.add_argument("payload", help="record payload, e.g. 'SET key value'")

    p_verify = sub.add_parser("verify", help="verify the hash chain")
    add_dir(p_verify)

    p_replay = sub.add_parser("replay", help="rebuild in-memory state")
    add_dir(p_replay)
    p_replay.add_argument("--full", action="store_true",
                          help="ignore snapshots, replay every record")

    p_snap = sub.add_parser("snapshot", help="write a periodic snapshot")
    add_dir(p_snap)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "append":
            seq, digest = append(args.dir, args.payload)
            print(f"appended {seq} {digest}")
        elif args.cmd == "verify":
            count, digest = verify(args.dir)
            print(f"OK: {count} records, head {digest}")
        elif args.cmd == "replay":
            state = replay(args.dir, use_snapshot=not args.full)
            print(json.dumps(state, indent=2, sort_keys=True))
        elif args.cmd == "snapshot":
            path = snapshot(args.dir)
            print(f"snapshot written: {path}")
    except PolicyError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0
