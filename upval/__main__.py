"""Command line interface: python -m upval src.fn [--run] [--debug-json]."""

import argparse
import json
import sys

from .errors import (
    COMPILE_ERROR_EXIT,
    RUNTIME_ERROR_EXIT,
    CompileError,
    UpvalRuntimeError,
)
from .evaluator import Evaluator, format_value
from .parser import parse
from .resolver import resolve


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="upval",
        description="Compile and run upval closure programs.",
    )
    parser.add_argument("source", help="path to the .fn source file")
    parser.add_argument(
        "--run", action="store_true", help="execute the program after compiling"
    )
    parser.add_argument(
        "--debug-json",
        action="store_true",
        help="print escape-analysis / capture information as JSON",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.source, "r", encoding="utf-8") as handle:
            src = handle.read()
    except OSError as exc:
        print(
            json.dumps({"error": "IOError", "message": str(exc)}),
            file=sys.stderr,
        )
        return 2

    try:
        program = parse(src)
        analysis = resolve(program)
    except CompileError as err:
        print(json.dumps(err.to_dict()), file=sys.stderr)
        return COMPILE_ERROR_EXIT

    if args.debug_json:
        print(json.dumps(analysis.to_dict(), indent=2))

    if args.run:
        try:
            result = Evaluator().run(program)
        except UpvalRuntimeError as err:
            print(json.dumps(err.to_dict()), file=sys.stderr)
            return RUNTIME_ERROR_EXIT
        print(f"=> {format_value(result)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
