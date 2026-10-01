"""CLI: python -m inclex doc.txt [--edit start,end,text]

Prints a JSON header line with ``changed_tokens``/``token_count`` followed
by the tokens as JSONL (one JSON object per line).

Exit codes: 0 ok, 1 EditError/LexError, 2 usage/IO error,
11 internal consistency assertion failure.
"""
from __future__ import annotations

import argparse
import json
import sys

from .incremental import Document, EditError, InternalConsistencyError
from .lexer import LexError

EXIT_OK = 0
EXIT_LEX_EDIT_ERROR = 1
EXIT_USAGE = 2
EXIT_INTERNAL_ERROR = 11


def _parse_edit(spec: str) -> tuple[int, int, str]:
    parts = spec.split(",", 2)
    if len(parts) != 3:
        raise EditError("edit spec must be 'start,end,text'", 0, "main")
    try:
        start = int(parts[0])
        end = int(parts[1])
    except ValueError:
        raise EditError("edit offsets must be integers", 0, "main") from None
    return start, end, parts[2]


def _emit_error(exc) -> None:
    print(
        json.dumps(
            {
                "error": exc.message,
                "offset": exc.offset,
                "state": exc.state,
            }
        ),
        file=sys.stderr,
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m inclex",
        description="Lex a document, optionally applying one incremental "
        "edit [start,end) -> text, and print tokens as JSONL.",
    )
    parser.add_argument("file", help="UTF-8 text document to lex")
    parser.add_argument(
        "--edit",
        metavar="START,END,TEXT",
        help="replace the half-open range [START,END) with TEXT, then "
        "re-lex incrementally (TEXT may itself contain commas)",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.file, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        print(f"error: cannot read {args.file}: {exc}", file=sys.stderr)
        return EXIT_USAGE

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        _emit_error(EditError(f"invalid UTF-8: {exc.reason}", exc.start,
                              "decode"))
        return EXIT_LEX_EDIT_ERROR

    try:
        doc = Document(text)
        if args.edit is not None:
            start, end, replacement = _parse_edit(args.edit)
            result = doc.edit(start, end, replacement)
            tokens = result.tokens
            changed = result.changed_tokens
        else:
            tokens = doc.tokens
            changed = len(tokens)
    except (EditError, LexError) as exc:
        _emit_error(exc)
        return EXIT_LEX_EDIT_ERROR
    except InternalConsistencyError as exc:
        print(f"internal consistency failure: {exc}", file=sys.stderr)
        return EXIT_INTERNAL_ERROR

    print(json.dumps({"changed_tokens": changed, "token_count": len(tokens)}))
    for tok in tokens:
        print(json.dumps(tok.to_dict()))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
