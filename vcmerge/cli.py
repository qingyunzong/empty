"""Command line interface: python -m vcmerge merge LEFT RIGHT --out OUT."""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from . import MergeError, NegativeCounterError, canonical_dumps, merge_documents

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NEGATIVE_COUNTER = 3


def _load_document(path: str) -> object:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vcmerge",
        description="Deterministically merge two replicas of a JSON document "
        "using vector clocks (no wall-clock tie-breaking).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    merge_parser = subparsers.add_parser(
        "merge", help="merge two replica documents and write the result"
    )
    merge_parser.add_argument("left", help="path to the left replica JSON document")
    merge_parser.add_argument("right", help="path to the right replica JSON document")
    merge_parser.add_argument(
        "--out", required=True, help="path for the merged canonical JSON output"
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "merge":
        try:
            left = _load_document(args.left)
            right = _load_document(args.right)
        except OSError as exc:
            print(f"vcmerge: cannot read input: {exc}", file=sys.stderr)
            return EXIT_ERROR
        except json.JSONDecodeError as exc:
            print(f"vcmerge: invalid JSON input: {exc}", file=sys.stderr)
            return EXIT_ERROR
        try:
            result = merge_documents(left, right)
        except NegativeCounterError as exc:
            print(f"vcmerge: {exc}", file=sys.stderr)
            return EXIT_NEGATIVE_COUNTER
        except MergeError as exc:
            print(f"vcmerge: {exc}", file=sys.stderr)
            return EXIT_ERROR
        try:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(canonical_dumps(result.document))
        except OSError as exc:
            print(f"vcmerge: cannot write output: {exc}", file=sys.stderr)
            return EXIT_ERROR
        print(result.conflicts)
        return EXIT_OK
    return EXIT_ERROR  # pragma: no cover - argparse enforces a subcommand
