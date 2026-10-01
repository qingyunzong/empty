"""CLI: python -m csp_persist [write|load] --log <path> [--clause <json>]

Exit codes:
  0  success
  2  log path not writable / log I/O error
  3  invalid clause JSON or schema
"""

from __future__ import annotations

import argparse
import json
import sys

from .log import ClauseFormatError, LogWriteError, append_clause, load_clauses, parse_clause_text

EXIT_OK = 0
EXIT_IO_ERROR = 2
EXIT_BAD_CLAUSE = 3


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="csp_persist", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_write = sub.add_parser("write", help="append one nogood clause to the log")
    p_write.add_argument("--log", required=True, help="path to the nogood log")
    p_write.add_argument("--clause", required=True, help="clause as JSON, e.g. '[[\"x\",1],[\"y\",2]]'")

    p_load = sub.add_parser("load", help="load committed clauses from the log")
    p_load.add_argument("--log", required=True, help="path to the nogood log")

    args = parser.parse_args(argv)

    if args.command == "write":
        try:
            clause = parse_clause_text(args.clause)
        except ClauseFormatError as exc:
            print(json.dumps({"status": "error", "error": f"invalid clause: {exc}"}), file=sys.stderr)
            return EXIT_BAD_CLAUSE
        try:
            append_clause(args.log, clause)
        except LogWriteError as exc:
            print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
            return EXIT_IO_ERROR
        print(json.dumps({"status": "ok", "committed": True, "log": args.log}))
        return EXIT_OK

    # load
    try:
        clauses = load_clauses(args.log)
    except LogWriteError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return EXIT_IO_ERROR
    print(json.dumps({"status": "ok", "clauses": clauses, "count": len(clauses)}))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
