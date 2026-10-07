"""JSON command-line interface.

Reads a JSON request from stdin (or --input) and writes a JSON response to
stdout (or --output).

Requests:
  {"op": "analyze", "ast": <ast>, "budget": {"max_steps": N, "max_word_len": M},
   "resume": <resume object from an "unknown" result>}
  {"op": "verify", "ast": <ast>, "word": "...", "parse": <parse tree>}

AST JSON:
  {"type": "lit", "char": "a", "id": 1}
  {"type": "eps", "id": 2}
  {"type": "union", "children": [...], "id": 3}
  {"type": "cat", "children": [...], "id": 4}
  {"type": "star", "child": {...}, "id": 5}
Ids are optional; missing ids are assigned deterministically in pre-order.

Parse-tree JSON:
  {"node": <id>, "span": [start, end], "children": [...]}
"""
from __future__ import annotations

import argparse
import json
import sys

from . import astnodes, parses
from .analyzer import analyze
from .verifier import verify_parse


def handle(request: dict) -> dict:
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    op = request.get("op", "analyze")
    if op == "analyze":
        root = astnodes.from_json(request["ast"])
        budget = request.get("budget") or {}
        return analyze(root,
                       max_steps=int(budget.get("max_steps", 100000)),
                       max_word_len=budget.get("max_word_len"),
                       resume=request.get("resume"))
    if op == "verify":
        root = astnodes.from_json(request["ast"])
        tree = parses.from_json(request["parse"])
        ok, err = verify_parse(root, request.get("word", ""), tree)
        out = {"valid": ok}
        if not ok:
            out["error"] = err
        return out
    raise ValueError(f"unknown op {op!r}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="regex_ambiguity",
        description="Ambiguity analysis for regular-expression ASTs (JSON in/out).")
    parser.add_argument("--input", "-i", help="JSON request file (default: stdin)")
    parser.add_argument("--output", "-o", help="JSON response file (default: stdout)")
    args = parser.parse_args(argv)
    try:
        if args.input:
            with open(args.input, "r", encoding="utf-8") as fh:
                request = json.load(fh)
        else:
            request = json.load(sys.stdin)
        response = handle(request)
    except Exception as exc:  # report malformed input as JSON, not a traceback
        response = {"error": f"{type(exc).__name__}: {exc}"}
    text = json.dumps(response, indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 0
