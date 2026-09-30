"""Command line interface: python -m rbacx check --db db.json --user u --perm p"""

from __future__ import annotations

import argparse
import json
import sys

from .core import PolicyError, load_policy

EXIT_OK = 0
EXIT_POLICY_ERROR = 2


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rbacx", description="RBAC policy engine over a role DAG")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="evaluate one (user, permission) query")
    check.add_argument("--db", required=True, help="path to the JSON policy database")
    check.add_argument("--user", required=True, help="subject to evaluate")
    check.add_argument("--perm", required=True, help="permission to evaluate")
    return parser


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        with open(args.db, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        print(json.dumps({"error": "db_unreadable", "message": str(exc)}), file=sys.stderr)
        return EXIT_POLICY_ERROR
    try:
        policy = load_policy(text)
        result = policy.check(args.user, args.perm)
    except PolicyError as exc:
        print(json.dumps({"error": exc.code, "message": exc.message}), file=sys.stderr)
        return EXIT_POLICY_ERROR
    print(json.dumps(result, sort_keys=True))
    return EXIT_OK
