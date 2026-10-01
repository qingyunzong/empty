"""CLI: python -m tinyvm prog.bc [--trace]

Exit codes:
    0  success (stack top printed to stdout as JSON)
    2  StepLimit        instruction step limit exceeded
    3  FrameOverflow    call frame limit exceeded
    4  StackOverflow    operand stack limit exceeded
    5  RuntimeFault     e.g. division/modulo by zero
    6  VMError          bytecode failed load-time verification
    7  EmptyHalt        HALT with an empty operand stack
"""

import argparse
import json
import sys

from .errors import VMError, VMFault
from .loader import load
from .vm import VM


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m tinyvm",
        description="Run a tinyvm bytecode program.",
    )
    parser.add_argument("program", help="path to the .bc bytecode file")
    parser.add_argument(
        "--trace",
        action="store_true",
        help="log every executed instruction to stderr",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.program, "rb") as handle:
            data = handle.read()
    except OSError as exc:
        print(f"VMError: cannot read {args.program}: {exc}", file=sys.stderr)
        return VMError.exit_code

    try:
        program = load(data)
    except VMError as exc:
        print(f"VMError: {exc}", file=sys.stderr)
        return VMError.exit_code

    vm = VM(program, trace=args.trace, trace_file=sys.stderr)
    try:
        result = vm.run()
    except VMFault as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return exc.exit_code

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
