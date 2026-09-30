"""CLI: python -m cdcsync apply --log LOG --db DB --ckpt CK"""
from __future__ import annotations

import argparse
import json
import sys

from . import core


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="cdcsync",
        description="Apply JSONL change logs to a SQLite KV store with exactly-once semantics.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_apply = sub.add_parser("apply", help="apply a JSONL change log")
    p_apply.add_argument("--log", required=True, help="path to the JSONL change log")
    p_apply.add_argument("--db", required=True, help="path to the main SQLite database")
    p_apply.add_argument("--ckpt", required=True, help="path to the checkpoint SQLite database")

    p_dump = sub.add_parser("dump", help="print the KV store as JSON")
    p_dump.add_argument("--db", required=True, help="path to the main SQLite database")

    args = parser.parse_args(argv)

    if args.cmd == "apply":
        try:
            counts = core.apply_log(args.log, args.db, args.ckpt)
        except core.LogValidationError as exc:
            for err in exc.errors:
                print(f"error: {err}", file=sys.stderr)
            print(json.dumps({"applied": 0, "pending": 0, "failed": exc.failed, "ignored": 0}))
            return 3
        except core.FaultInject as exc:
            print(f"fault: {exc}", file=sys.stderr)
            return 1
        except FileNotFoundError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        except Exception as exc:  # noqa: BLE001 - CLI boundary
            print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 2
        print(json.dumps(counts))
        return 0

    if args.cmd == "dump":
        try:
            print(json.dumps(core.dump_kv(args.db), sort_keys=True, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001 - CLI boundary
            print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 2
        return 0

    return 2  # unreachable


if __name__ == "__main__":
    sys.exit(main())
