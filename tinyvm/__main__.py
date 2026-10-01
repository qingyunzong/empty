"""Command line interface: ``python -m tinyvm prog.bc [--trace]``.

Exit codes:
    0  normal HALT, stack top printed to stdout as JSON
    3  RuntimeFault (e.g. division by zero)
    5  EmptyHalt (HALT with empty operand stack)
    6  VMError (load/verify failure, unreadable file)
    7  StackOverflow
    8  FrameOverflow
    9  StepLimit
"""

from __future__ import annotations

import argparse
import json
import sys

from . import program as program_mod
from .errors import RuntimeFault, VMError
from .vm import DEFAULT_STEP_LIMIT, VM


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tinyvm")
    parser.add_argument("file", help="bytecode image (.bc)")
    parser.add_argument(
        "--trace",
        action="store_true",
        help="log every executed instruction to stderr",
    )
    parser.add_argument(
        "--step-limit",
        type=int,
        default=DEFAULT_STEP_LIMIT,
        help="instruction step limit (default: %(default)s)",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.file, "rb") as handle:
            data = handle.read()
    except OSError as exc:
        print("tinyvm: error: cannot read %s: %s" % (args.file, exc), file=sys.stderr)
        return 6

    try:
        prog = program_mod.loads(data)
    except VMError as exc:
        print("tinyvm: error: %s" % exc, file=sys.stderr)
        return 6

    machine = VM(prog, step_limit=args.step_limit, trace=args.trace)
    try:
        machine.run()
    except RuntimeFault as exc:
        print("tinyvm: %s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return exc.exit_code

    json.dump({"result": machine.stack[-1]}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
