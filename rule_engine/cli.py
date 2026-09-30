"""Command line interface for the rule engine.

Usage:
    python -m rule_engine [--state PATH] assert <fact>
    python -m rule_engine [--state PATH] retract <fact>
    python -m rule_engine [--state PATH] rule "<head>:-<a,b,not c>"
    python -m rule_engine [--state PATH] derive <fact>
    python -m rule_engine [--state PATH] facts
    python -m rule_engine [--state PATH] rules

State is persisted as JSON (default ``.rule_engine_state.json`` in the
current directory, or the path from ``RULE_ENGINE_STATE`` / ``--state``).

Exit codes:
    0  success (derive: fact holds)
    1  generic failure (derive: fact does not hold; retract of non-base fact)
    2  rule/fact syntax error
    6  attempted to assert a derived fact
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .engine import (
    DerivedFactError,
    Engine,
    NotBaseFactError,
    RuleSyntaxError,
)

DEFAULT_STATE = ".rule_engine_state.json"


def load_engine(path: str) -> Engine:
    engine = Engine()
    if not os.path.exists(path):
        return engine
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    for fact in data.get("base", []):
        engine.assert_fact(fact)
    for rule_text in data.get("rules", []):
        engine.add_rule(rule_text)
    return engine


def save_engine(engine: Engine, path: str) -> None:
    data = {
        "base": sorted(engine.base),
        "rules": [str(rule) for rule in engine.rules],
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rule_engine")
    parser.add_argument(
        "--state",
        default=os.environ.get("RULE_ENGINE_STATE", DEFAULT_STATE),
        help="path to the state file",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("assert", "retract", "derive"):
        cmd = sub.add_parser(name)
        cmd.add_argument("fact")
    rule_cmd = sub.add_parser("rule")
    rule_cmd.add_argument("rule")
    sub.add_parser("facts")
    sub.add_parser("rules")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        engine = load_engine(args.state)
    except (OSError, json.JSONDecodeError, RuleSyntaxError, DerivedFactError) as exc:
        print(f"error: cannot load state: {exc}", file=sys.stderr)
        return 2

    try:
        if args.command == "assert":
            engine.assert_fact(args.fact)
            save_engine(engine, args.state)
            return 0
        if args.command == "retract":
            engine.retract_fact(args.fact)
            save_engine(engine, args.state)
            return 0
        if args.command == "rule":
            rule = engine.add_rule(args.rule)
            save_engine(engine, args.state)
            print(f"rule {rule.id}: {rule}")
            return 0
        if args.command == "derive":
            holds = engine.derives(args.fact)
            print("true" if holds else "false")
            return 0 if holds else 1
        if args.command == "facts":
            for fact in sorted(engine.facts):
                kind = "base" if fact in engine.base else "derived"
                print(f"{fact}\t{kind}")
            return 0
        if args.command == "rules":
            for rule in engine.rules:
                print(f"{rule.id}: {rule}")
            return 0
    except DerivedFactError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 6
    except RuleSyntaxError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except NotBaseFactError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
