"""JSON command line interface.

Usage:
    python3.11 -m budget_auth.cli --db STATE.log --script ops.json
    python3.11 -m budget_auth.cli --db STATE.log --recover-only

The script file is ``{"ops": [<op>, ...]}``.  Every op is applied to the
state recovered from ``--db`` (created if missing); accepted mutating ops
are appended to the log.  A JSON document with per-op results and the
final state is printed to stdout.
"""
import argparse
import json
import os
import sys

from .system import Authorizer


def main(argv=None):
    parser = argparse.ArgumentParser(prog="budget_auth")
    parser.add_argument("--db", required=True,
                        help="path to the JSONL state log")
    parser.add_argument("--script", help="JSON file with an 'ops' list")
    parser.add_argument("--recover-only", action="store_true",
                        help="only recover and print the state")
    args = parser.parse_args(argv)

    auth = Authorizer.recover(args.db)
    results = []
    if args.script and not args.recover_only:
        with open(args.script, encoding="utf-8") as fh:
            script = json.load(fh)
        for op in script.get("ops", []):
            results.append(auth.apply(op))
    json.dump({"results": results, "state": auth.snapshot()},
              sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    auth.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
