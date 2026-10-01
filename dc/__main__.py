import argparse
import json
import sys

from .core import (
    CrashRequested,
    SemanticError,
    Store,
    execute,
    load_transaction,
)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="dc")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run", help="run a transaction file")
    run_parser.add_argument("tx", help="path to transaction JSON file")
    run_parser.add_argument("--state", required=True, help="state directory")
    run_parser.add_argument(
        "--fail-after",
        type=int,
        default=None,
        metavar="K",
        help="exit 3 after K durable WAL records (crash simulation)",
    )
    args = parser.parse_args(argv)

    if args.command == "run":
        try:
            tx = load_transaction(args.tx)
        except (OSError, ValueError) as exc:
            print("error: invalid transaction file: %s" % exc, file=sys.stderr)
            return 2
        store = Store(args.state)
        try:
            code, results = execute(store, tx, args.fail_after)
        except CrashRequested:
            return 3
        except SemanticError as exc:
            print("semantic error: %s" % exc, file=sys.stderr)
            return 1
        print(json.dumps({"id": tx["id"], "results": results}))
        return code
    return 2


if __name__ == "__main__":
    sys.exit(main())
