"""CLI: python -m dc run TX.json --state DIR [--fail-after K]"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .core import SemanticError, TxFormatError, run_tx, validate_tx


def build_parser():
    parser = argparse.ArgumentParser(
        prog="dc", description="Transactional undirected-graph store"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a transaction file against a state dir")
    run.add_argument("tx_file", help="path to the transaction JSON file")
    run.add_argument("--state", required=True, help="state directory")
    run.add_argument(
        "--fail-after",
        type=int,
        default=None,
        metavar="K",
        help="simulate a crash after K durable WAL records (exit 3)",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.fail_after is not None and args.fail_after < 1:
        print("error: --fail-after must be >= 1", file=sys.stderr)
        return 2

    try:
        with open(args.tx_file, "r", encoding="utf-8") as f:
            tx = json.load(f)
    except OSError as exc:
        print(f"error: cannot read transaction file: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON: {exc}", file=sys.stderr)
        return 2

    try:
        validate_tx(tx)
    except TxFormatError as exc:
        print(f"error: invalid transaction: {exc}", file=sys.stderr)
        return 2

    os.makedirs(args.state, exist_ok=True)

    try:
        results = run_tx(args.state, tx, fail_after=args.fail_after)
    except SemanticError as exc:
        print(f"semantic error: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {"id": tx["id"], "status": "committed", "results": results},
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
