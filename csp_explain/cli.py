"""Command line interface: python -m csp_explain generate --input <file>."""
from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .model import ValidationError, parse_model
from .uip import AnalysisError, generate_explanation

EXIT_OK = 0
EXIT_ERROR = 2


def _fail(message: str) -> int:
    json.dump({"error": message}, sys.stderr, ensure_ascii=False)
    sys.stderr.write("\n")
    return EXIT_ERROR


def _cmd_generate(args: argparse.Namespace) -> int:
    try:
        with open(args.input, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        return _fail(f"cannot read input file: {exc}")
    except json.JSONDecodeError as exc:
        return _fail(f"invalid JSON in input file: {exc}")

    try:
        model = parse_model(data)
    except ValidationError as exc:
        return _fail(f"invalid conflict record: {exc}")

    try:
        explanation = generate_explanation(model)
    except AnalysisError as exc:
        return _fail(f"analysis failed: {exc}")

    payload = explanation.to_dict()
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
        except OSError as exc:
            return _fail(f"cannot write output file: {exc}")
    else:
        print(text)
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="csp_explain",
        description="1-UIP conflict explanation generator for backtracking "
        "search with implication logging.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    gen = sub.add_parser(
        "generate", help="generate the 1-UIP explanation clause for a conflict record"
    )
    gen.add_argument("--input", required=True, help="path to the conflict record JSON file")
    gen.add_argument("--output", help="optional path for the explanation JSON (default: stdout)")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "generate":
        return _cmd_generate(args)
    return _fail(f"unknown command: {args.command}")
