"""Command line interface: ``python -m inclex FILE [--edit START,END,TEXT]...``

Prints ``changed_tokens: N`` followed by the token stream as JSONL.

Exit codes: 0 ok, 2 usage/IO error, 3 EditError, 4 LexError,
11 internal consistency assertion failure.
"""

from __future__ import annotations

import argparse
import json
import sys

from .lexer import (
    EditError,
    IncrementalLexer,
    InternalConsistencyError,
    LexError,
)


def _parse_edit(spec: str) -> tuple[int, int, str]:
    parts = spec.split(",", 2)
    if len(parts) != 3:
        raise ValueError(f"invalid --edit spec {spec!r}; want START,END,TEXT")
    start_s, end_s, text = parts
    return int(start_s), int(end_s), text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="inclex",
        description="Incrementally re-lex FILE after applying edits.",
    )
    parser.add_argument("file", help="UTF-8 source file to lex")
    parser.add_argument(
        "--edit",
        action="append",
        default=[],
        metavar="START,END,TEXT",
        help="replace [START,END) with TEXT; may be repeated, applied in order",
    )
    args = parser.parse_args(argv)

    edits = []
    for spec in args.edit:
        try:
            edits.append(_parse_edit(spec))
        except ValueError as exc:
            print(f"inclex: {exc}", file=sys.stderr)
            return 2

    try:
        with open(args.file, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        print(f"inclex: {exc}", file=sys.stderr)
        return 2

    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        err = EditError("invalid UTF-8 input", exc.start)
        print(f"EditError: {err}", file=sys.stderr)
        return 3

    lexer = IncrementalLexer()
    changed = 0
    try:
        lexer.set_text(source)
        for start, end, text in edits:
            changed = lexer.apply_edit(start, end, text)
    except EditError as exc:
        print(f"EditError: {exc}", file=sys.stderr)
        return 3
    except LexError as exc:
        print(f"LexError: {exc}", file=sys.stderr)
        return 4
    except InternalConsistencyError as exc:
        print(f"InternalConsistencyError: {exc}", file=sys.stderr)
        return 11

    print(f"changed_tokens: {changed}")
    for token in lexer.tokens:
        print(
            json.dumps(
                {
                    "type": token.type,
                    "start": token.start,
                    "end": token.end,
                    "value": token.value,
                },
                ensure_ascii=False,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
