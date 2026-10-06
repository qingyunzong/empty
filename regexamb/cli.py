"""JSON command-line interface for the ambiguity analyser.

Reads a JSON request from stdin (or ``--input``) and writes a JSON result
to stdout.  Request fields:

- ``pattern``: pattern string, or ``ast``: AST JSON with explicit ids
- ``alphabet``: optional list of characters (lexicographic order)
- ``budget``: optional work budget for the witness search
- ``resume``: optional path to a checkpoint JSON from an earlier run
- ``checkpoint``: optional path to write a checkpoint when the result is
  ``unknown``
"""
from __future__ import annotations

import argparse
import json
import sys

from .syntax import parse_pattern, ast_from_json
from .analyze import analyze


def _build_request(req: dict):
    if "ast" in req:
        root = ast_from_json(req["ast"])
    elif "pattern" in req:
        root = parse_pattern(req["pattern"])
    else:
        raise ValueError("request needs a 'pattern' or an 'ast' field")
    alphabet = req.get("alphabet")
    if isinstance(alphabet, str):
        alphabet = list(alphabet)
    return root, alphabet


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="regexamb")
    parser.add_argument("--input", "-i", help="JSON request file (default: stdin)")
    parser.add_argument("--pretty", action="store_true", help="pretty-print the result")
    args = parser.parse_args(argv)

    try:
        if args.input:
            with open(args.input, encoding="utf-8") as fh:
                req = json.load(fh)
        else:
            req = json.load(sys.stdin)
        root, alphabet = _build_request(req)
        budget = int(req.get("budget", 200000))
        resume_state = None
        if req.get("resume"):
            with open(req["resume"], encoding="utf-8") as fh:
                resume_state = json.load(fh)
        result = analyze(root, alphabet=alphabet, budget=budget,
                         resume_state=resume_state)
        if result.get("status") == "unknown" and req.get("checkpoint"):
            with open(req["checkpoint"], "w", encoding="utf-8") as fh:
                json.dump(result["checkpoint"], fh)
            result["checkpoint_file"] = req["checkpoint"]
    except Exception as exc:  # noqa: BLE001 - report any failure as JSON
        json.dump({"status": "error", "message": str(exc)}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    indent = 2 if args.pretty else None
    json.dump(result, sys.stdout, indent=indent)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
