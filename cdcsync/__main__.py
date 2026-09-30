"""CLI: python -m cdcsync apply --log LOG --db DB --ckpt CK"""
from __future__ import annotations

import argparse
import json
import sys

from .core import CorruptLog, Engine, FaultInject

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CORRUPT = 3
EXIT_FAULT = 4


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="cdcsync",
        description="Apply a JSONL CDC log to a SQLite key/value table "
                    "with exactly-once semantics.")
    sub = parser.add_subparsers(dest="command", required=True)
    apply_p = sub.add_parser("apply", help="apply a CDC log")
    apply_p.add_argument("--log", required=True, help="JSONL change log")
    apply_p.add_argument("--db", required=True, help="SQLite database path")
    apply_p.add_argument("--ckpt", required=True,
                         help="checkpoint file (JSON mirror of the "
                              "checkpoint stored transactionally in the DB)")
    args = parser.parse_args(argv)

    if args.command == "apply":
        engine = Engine(args.db, args.ckpt)
        try:
            counts = engine.run(args.log)
        except CorruptLog as exc:
            print(f"cdcsync: error: {exc}", file=sys.stderr)
            print(json.dumps(engine.snapshot(), sort_keys=True))
            return EXIT_CORRUPT
        except FaultInject as exc:
            print(f"cdcsync: fault injected: {exc}", file=sys.stderr)
            return EXIT_FAULT
        except OSError as exc:
            print(f"cdcsync: error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        finally:
            engine.close()
        print(json.dumps(counts, sort_keys=True))
        return EXIT_OK
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
