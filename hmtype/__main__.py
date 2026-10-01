"""CLI: python -m hmtype FILE

Prints the principal type of every top-level let to stdout and JSON
error objects (one per line) to stderr.  Exit code is 4 when any error
was reported (including the parse stage), 0 on success, 2 on usage/IO
errors.
"""
from __future__ import annotations

import json
import sys

from .infer import infer_program
from .parser import ParseError, parse_program

EXIT_TYPE_ERROR = 4
EXIT_USAGE = 2


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("usage: python -m hmtype FILE", file=sys.stderr)
        return EXIT_USAGE
    try:
        with open(args[0], "r", encoding="utf-8") as handle:
            src = handle.read()
    except OSError as exc:
        print(json.dumps({"kind": "IOError", "message": str(exc)}), file=sys.stderr)
        return EXIT_USAGE
    try:
        decls = parse_program(src)
    except ParseError as exc:
        print(json.dumps(exc.to_json(), ensure_ascii=False), file=sys.stderr)
        return EXIT_TYPE_ERROR
    results, errors = infer_program(decls)
    for name, ty in results:
        print(f"{name} : {ty}")
    for err in errors:
        print(json.dumps(err, ensure_ascii=False), file=sys.stderr)
    return EXIT_TYPE_ERROR if errors else 0


if __name__ == "__main__":
    sys.exit(main())
