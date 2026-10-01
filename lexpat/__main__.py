"""CLI: python -m lexpat --spec spec.json --input file

Prints one JSON token per line (JSONL) on stdout.  On any LexError a
single JSON error object is printed on stderr, stdout stays empty, and
the exit code is 2.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import Lexer, LexError


def _emit_error(exc):
    print(json.dumps(exc.to_dict(), ensure_ascii=False), file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="lexpat",
        description="Tokenize INPUT with the lexpat SPEC and print JSONL tokens.",
    )
    parser.add_argument("--spec", required=True, help="path to the lexer spec (JSON)")
    parser.add_argument(
        "--input", required=True, help="path to the input file (UTF-8, no BOM)"
    )
    args = parser.parse_args(argv)

    try:
        with open(args.spec, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    except OSError as exc:
        _emit_error(LexError(f"cannot read spec file: {exc}"))
        return 2
    except json.JSONDecodeError as exc:
        _emit_error(LexError(f"spec is not valid JSON: {exc}"))
        return 2

    try:
        with open(args.input, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        _emit_error(LexError(f"cannot read input file: {exc}"))
        return 2

    if raw.startswith(b"\xef\xbb\xbf"):
        _emit_error(
            LexError("input has a UTF-8 BOM, which is rejected", line=1, col=1, mode="main")
        )
        return 2
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        prefix = raw[: exc.start].decode("utf-8", errors="ignore")
        line = prefix.count("\n") + 1
        col = len(prefix) - prefix.rfind("\n") if "\n" in prefix else len(prefix) + 1
        _emit_error(
            LexError(f"input is not valid UTF-8: {exc.reason}", line=line, col=col, mode="main")
        )
        return 2

    try:
        tokens = Lexer(spec).tokenize(text)
    except LexError as exc:
        _emit_error(exc)
        return 2

    for token in tokens:
        sys.stdout.write(json.dumps(token, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
