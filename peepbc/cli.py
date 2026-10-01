"""Command line interface: python -m peepbc in.bc -o out.bc [--verify]."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .model import ParseError, dump, parse
from .optimize import optimize
from .verify import MAX_DEPTH, verify

EXIT_VERIFY_FAIL = 7


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="peepbc",
        description="Safe peephole optimizer for G3-style stack bytecode.",
    )
    ap.add_argument("input", help="input .bc file")
    ap.add_argument("-o", "--output", required=True, help="output .bc file")
    ap.add_argument(
        "--verify",
        action="store_true",
        help="print a verification report (verification always runs; "
        "on failure nothing is written and the exit code is 7)",
    )
    ap.add_argument(
        "--max-depth",
        type=int,
        default=MAX_DEPTH,
        help="maximum allowed operand stack depth (default: 256)",
    )
    args = ap.parse_args(argv)

    try:
        text = Path(args.input).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"peepbc: cannot read {args.input}: {exc}", file=sys.stderr)
        return 1
    try:
        prog = parse(text)
    except ParseError as exc:
        print(f"peepbc: parse error: {exc}", file=sys.stderr)
        return 1

    opt, mapping = optimize(prog)

    errors = verify(opt, args.max_depth)
    if errors:
        for err in errors:
            print(f"peepbc: verification failed: {err}", file=sys.stderr)
        print("peepbc: refusing to write output", file=sys.stderr)
        return EXIT_VERIFY_FAIL

    try:
        Path(args.output).write_text(dump(opt, mapping), encoding="utf-8")
    except OSError as exc:
        print(f"peepbc: cannot write {args.output}: {exc}", file=sys.stderr)
        return 1

    removed = len(prog.code) - len(opt.code)
    print(
        f"peepbc: {len(prog.code)} -> {len(opt.code)} instructions "
        f"({removed} removed), {len(mapping)} mapping entries -> {args.output}"
    )
    if args.verify:
        print(f"peepbc: verification OK (max stack depth <= {args.max_depth})")
    return 0
