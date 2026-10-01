"""Command line interface for the rule engine.

Usage:
    python -m rule_engine                 # read commands from stdin
    python -m rule_engine derive p        # run a single command

Commands (one per line):
    assert <fact>       add a base fact (error, exit 6, if it is derived)
    retract <fact>      remove a base fact (no-op for derived/unknown facts)
    rule <h>:-<a,b,not c>   add a rule (syntax error -> exit 2)
    derive <fact>       print "yes"/"no"; single-command exit code 0/1

Blank lines and lines starting with '#' are ignored.
"""

from __future__ import annotations

import sys

from .engine import AssertDerivedError, Engine, RuleSyntaxError, parse_atom

EXIT_ASSERT_DERIVED = 6
EXIT_SYNTAX = 2


def _parse_fact_arg(rest, cmd):
    if not rest:
        raise RuleSyntaxError(f"{cmd}: missing fact argument")
    return parse_atom(rest)


def run_command(engine, line, out):
    """Execute one command line. Returns an exit code for 'derive', else None."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    parts = line.split(None, 1)
    cmd = parts[0]
    rest = parts[1].strip() if len(parts) > 1 else ""
    if cmd == "assert":
        engine.assert_fact(_parse_fact_arg(rest, cmd))
        print("ok", file=out)
    elif cmd == "retract":
        engine.retract_fact(_parse_fact_arg(rest, cmd))
        print("ok", file=out)
    elif cmd == "rule":
        if not rest:
            raise RuleSyntaxError("rule: missing rule definition")
        rid = engine.add_rule(rest)
        print(f"ok {rid}", file=out)
    elif cmd == "derive":
        fact = _parse_fact_arg(rest, cmd)
        if engine.holds(fact):
            print("yes", file=out)
            return 0
        print("no", file=out)
        return 1
    else:
        raise RuleSyntaxError(f"unknown command: {cmd!r}")
    return None


def main(argv=None, stdin=None, stdout=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    engine = Engine()
    lines = [" ".join(argv)] if argv else stdin
    final = 0
    for line in lines:
        try:
            rc = run_command(engine, line, stdout)
        except AssertDerivedError as exc:
            print(
                f"error: cannot assert derived fact: {exc}", file=sys.stderr
            )
            return EXIT_ASSERT_DERIVED
        except RuleSyntaxError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_SYNTAX
        if rc is not None:
            final = rc
    return final
