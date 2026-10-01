"""Command line interface: python -m lexpat --spec spec.json --input file

On success each token is printed to stdout as one JSON object per line
(JSONL). On any failure nothing is written to stdout, a single JSON
error object is written to stderr and the exit code is 2.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import LexError, lex, load_spec

_UTF8_BOM = b"\xef\xbb\xbf"


def _fail(payload):
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    return 2


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="lexpat",
        description="Lex a file with a JSON lexer spec and emit JSONL tokens.",
    )
    parser.add_argument("--spec", required=True, help="path to the JSON lexer spec")
    parser.add_argument("--input", required=True, help="path to the UTF-8 input file")
    args = parser.parse_args(argv)

    try:
        spec = load_spec(args.spec)
    except (OSError, ValueError) as exc:
        return _fail({"error": f"invalid spec: {exc}"})

    try:
        with open(args.input, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        return _fail({"error": f"cannot read input: {exc}"})
    if raw.startswith(_UTF8_BOM):
        return _fail({"error": "input has a UTF-8 BOM, which is not allowed"})
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return _fail({"error": f"input is not valid UTF-8: {exc}"})

    try:
        tokens = lex(text, spec)
    except LexError as exc:
        return _fail(exc.to_dict())

    for token in tokens:
        sys.stdout.write(json.dumps(token.to_dict(), ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
