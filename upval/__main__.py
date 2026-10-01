"""CLI: python -m upval <file.fn> [--run] [--debug]

Exit codes: 0 ok, 9 runtime error, 10 compile error.
Errors are reported as JSON on stderr with var/level/span fields.
"""

import argparse
import json
import sys

from . import compile_source, debug_dict, run_compiled
from .errors import UpvalError


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m upval",
        description="upval: a tiny language with upvalue capture",
    )
    parser.add_argument("file", help="source file to compile")
    parser.add_argument("--run", action="store_true",
                        help="execute the program and print its result")
    parser.add_argument("--debug", action="store_true",
                        help="print escape-analysis debug JSON")
    args = parser.parse_args(argv)

    try:
        with open(args.file, "r", encoding="utf-8") as handle:
            src = handle.read()
    except OSError as exc:
        print(json.dumps({
            "error": "IOError", "message": str(exc),
            "var": None, "level": None, "span": None,
        }), file=sys.stderr)
        return 2

    try:
        top = compile_source(src)
    except UpvalError as exc:
        print(json.dumps(exc.to_dict()), file=sys.stderr)
        return exc.exit_code  # 10

    if args.debug:
        print(json.dumps(debug_dict(top), indent=2))

    if args.run:
        try:
            result = run_compiled(top)
        except UpvalError as exc:
            print(json.dumps(exc.to_dict()), file=sys.stderr)
            return exc.exit_code  # 9
        print(result if isinstance(result, int) else "<fn>")

    return 0


if __name__ == "__main__":
    sys.exit(main())
