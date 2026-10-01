"""Command line interface:  python -m peepbc in.bc -o out.bc [--verify]"""

from __future__ import annotations

import argparse
import sys

from . import isa
from .asm import assemble
from .optimize import optimize
from .program import FormatError, Program
from .verify import verify

EXIT_VERIFY_FAILED = 7


def _read_program(path: str) -> Program:
    with open(path, "rb") as fh:
        prog, _ = Program.from_bytes(fh.read())
    return prog


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m peepbc",
        description="Peephole optimiser for peepbc bytecode.",
    )
    parser.add_argument("input", help="input file (.bc binary, or assembly with --asm)")
    parser.add_argument("-o", "--output", help="output .bc file (embeds the pc mapping)")
    parser.add_argument("--asm", action="store_true",
                        help="assemble text input to .bc instead of optimising")
    parser.add_argument("--dump", action="store_true",
                        help="disassemble the input and exit")
    parser.add_argument("--verify", action="store_true",
                        help="re-read the written output and verify it again")
    parser.add_argument("--max-stack", type=int, default=isa.MAX_STACK,
                        help="stack depth limit for verification (default 256)")
    args = parser.parse_args(argv)

    try:
        if args.asm:
            with open(args.input, "r", encoding="utf-8") as fh:
                prog = assemble(fh.read())
            if args.dump:
                print(prog.disassemble())
                return 0
            if not args.output:
                parser.error("--asm requires -o")
            with open(args.output, "wb") as fh:
                fh.write(prog.to_bytes())
            print(f"assembled {len(prog.code)} instructions -> {args.output}")
            return 0

        prog = _read_program(args.input)
        if args.dump:
            print(prog.disassemble())
            return 0
        if not args.output:
            parser.error("optimising requires -o")

        opt, mapping = optimize(prog)
        errors = verify(opt, max_stack=args.max_stack)
        if errors:
            for err in errors:
                print(f"verify: {err}", file=sys.stderr)
            print("verification failed; output not written", file=sys.stderr)
            return EXIT_VERIFY_FAILED

        with open(args.output, "wb") as fh:
            fh.write(opt.to_bytes(mapping=mapping))
        print(f"optimised {len(prog.code)} -> {len(opt.code)} instructions "
              f"-> {args.output}")
        print("mapping (old_pc -> new_pc):")
        for old_pc in sorted(mapping):
            print(f"  {old_pc} -> {mapping[old_pc]}")

        if args.verify:
            with open(args.output, "rb") as fh:
                reread, reread_map = Program.from_bytes(fh.read())
            errors = verify(reread, max_stack=args.max_stack)
            if errors:
                for err in errors:
                    print(f"verify: {err}", file=sys.stderr)
                return EXIT_VERIFY_FAILED
            if reread_map != mapping:
                print("verify: embedded mapping mismatch", file=sys.stderr)
                return EXIT_VERIFY_FAILED
            print("verify: OK")
        return 0
    except (OSError, FormatError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
