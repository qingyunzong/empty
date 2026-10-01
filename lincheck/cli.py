"""Command line interface: python -m lincheck verify history.json --impl ..."""

from __future__ import annotations

import argparse
import sys

from .checker import Verdict, check_history
from .history import HistoryError, load_history_text
from .models import ModelError, get_model

EXIT_LINEARIZABLE = 0
EXIT_NON_LINEARIZABLE = 1
EXIT_INVALID_INPUT = 2
EXIT_UNKNOWN = 5


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lincheck",
        description="Check linearizability of a concurrent history.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify", help="verify a history file")
    verify.add_argument("history", help="path to a JSON history file")
    verify.add_argument(
        "--impl",
        required=True,
        choices=["register", "queue"],
        help="sequential specification to check against",
    )
    verify.add_argument(
        "--max-states",
        type=int,
        default=100000,
        help="exploration budget before giving up with UNKNOWN_RESOURCE",
    )
    return parser


def _print_ops(ops) -> None:
    for pos, op in enumerate(ops):
        print(f"  {pos}: {op.describe()}")


def cmd_verify(args) -> int:
    try:
        with open(args.history, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        print(f"error: cannot read history file: {exc}", file=sys.stderr)
        return EXIT_INVALID_INPUT

    try:
        ops, initial = load_history_text(text)
        model = get_model(args.impl, initial)
        # Validate every operation name up front.
        for op in ops:
            model.kind(op)
    except (HistoryError, ModelError) as exc:
        print(f"error: invalid history: {exc}", file=sys.stderr)
        return EXIT_INVALID_INPUT

    if args.max_states <= 0:
        print("error: --max-states must be positive", file=sys.stderr)
        return EXIT_INVALID_INPUT

    result = check_history(ops, model, max_states=args.max_states)

    if result.verdict is Verdict.LINEARIZABLE:
        print("LINEARIZABLE")
        print("linearization:")
        _print_ops(result.linearization)
        return EXIT_LINEARIZABLE

    if result.verdict is Verdict.NON_LINEARIZABLE:
        print("NON_LINEARIZABLE")
        print("minimal conflicting prefix:")
        _print_ops(result.conflict_prefix)
        return EXIT_NON_LINEARIZABLE

    if result.verdict is Verdict.UNKNOWN:
        print("UNKNOWN")
        print(f"reason: {result.note}")
        print("witness linearization (assumes pending responses):")
        _print_ops(result.linearization)
        return EXIT_UNKNOWN

    # UNKNOWN_RESOURCE
    print("UNKNOWN_RESOURCE")
    print(f"reason: {result.note} (explored {result.states_explored} states)")
    return EXIT_UNKNOWN


def main(argv=None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "verify":
        return cmd_verify(args)
    parser.error("unknown command")
    return EXIT_INVALID_INPUT
