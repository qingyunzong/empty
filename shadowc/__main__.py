"""Command line interface: ``python -m shadowc compile policy.dsl --report out.json``.

Exit codes:
    0 -- compiled; diagnostics contain at most warnings
    1 -- compiled; diagnostics contain error-severity entries (E_SHADOW /
         E_UNREACHABLE); the report is still written
    2 -- PolicyError (E_PARSE) or I/O failure; no report is written
"""

from __future__ import annotations

import argparse
import json
import sys

from .compiler import compile_source
from .errors import PolicyError


def cmd_compile(args) -> int:
    try:
        with open(args.policy, "r", encoding="utf-8") as fh:
            source = fh.read()
    except OSError as exc:
        print(f"shadowc: error: cannot read {args.policy}: {exc}", file=sys.stderr)
        return 2
    try:
        compiled = compile_source(source)
    except PolicyError as exc:
        print(f"{args.policy}:{exc}", file=sys.stderr)
        return 2
    report = compiled.report()
    text = json.dumps(report, indent=2) + "\n"
    if args.report:
        try:
            with open(args.report, "w", encoding="utf-8") as fh:
                fh.write(text)
        except OSError as exc:
            print(f"shadowc: error: cannot write {args.report}: {exc}", file=sys.stderr)
            return 2
    else:
        sys.stdout.write(text)
    errors = sum(1 for d in compiled.diagnostics if d.severity == "error")
    warnings = sum(1 for d in compiled.diagnostics if d.severity == "warning")
    print(
        f"shadowc: {len(compiled.rules)} rule(s), "
        f"{errors} error(s), {warnings} warning(s)",
        file=sys.stderr,
    )
    return 1 if errors else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="shadowc", description="Compile a policy DSL into a decision table."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    compile_parser = sub.add_parser("compile", help="compile a policy file")
    compile_parser.add_argument("policy", help="path to the .dsl policy file")
    compile_parser.add_argument(
        "--report",
        metavar="PATH",
        help="write the JSON report {table, diagnostics} to PATH "
        "(default: stdout)",
    )
    args = parser.parse_args(argv)
    if args.command == "compile":
        return cmd_compile(args)
    parser.error(f"unknown command {args.command!r}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
