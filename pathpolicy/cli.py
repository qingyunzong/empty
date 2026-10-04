"""JSON command-line interface.

Each command reads one JSON document from stdin and writes one JSON
document to stdout:

    python3.11 -m pathpolicy.cli normalize  <<< '{"path": "a//./b"}'
    python3.11 -m pathpolicy.cli match      <<< '{"expr": "a/**", "path": "a/b"}'
    python3.11 -m pathpolicy.cli check      <<< '{"a": "a/[bc]", "b": {"union": ["a/b", "a/c"]}}'
    python3.11 -m pathpolicy.cli diff       <<< '{"a": "a/**", "b": "a/*/c", "all_shortest": true}'
    python3.11 -m pathpolicy.cli verify     <<< '{"a": "a/b", "b": "a/**", "proof": {...}}'
    python3.11 -m pathpolicy.cli enumerate  <<< '{"expr": "a/**/b", "names": ["a", "b"], "depth": 3}'
"""

import argparse
import json
import sys

from .enumerate import cross_check
from .normalize import normalize_path
from .proof import check_equivalence, find_difference, verify_inclusion_proof
from .ruleset import expr_from_json, expr_match


def _dispatch(command, payload):
    if command == "normalize":
        return {"ok": True, "path": normalize_path(payload["path"])}
    if command == "match":
        expr = expr_from_json(payload["expr"])
        normalized = normalize_path(payload["path"])
        return {"ok": True, "normalized": normalized, "match": expr_match(expr, normalized)}
    if command == "check":
        a = expr_from_json(payload["a"])
        b = expr_from_json(payload["b"])
        result = check_equivalence(a, b, payload.get("budget", 10000))
        result["ok"] = True
        return result
    if command == "diff":
        a = expr_from_json(payload["a"])
        b = expr_from_json(payload["b"])
        result = find_difference(
            a, b, payload.get("budget", 10000), payload.get("all_shortest", False)
        )
        result["ok"] = True
        return result
    if command == "verify":
        a = expr_from_json(payload["a"])
        b = expr_from_json(payload["b"])
        result = verify_inclusion_proof(
            a, b, payload["proof"], payload.get("budget", 10000)
        )
        result["ok"] = True
        return result
    if command == "enumerate":
        expr = expr_from_json(payload["expr"])
        result = cross_check(expr, payload["names"], payload["depth"])
        result["ok"] = True
        return result
    raise ValueError("unknown command %r" % command)  # pragma: no cover


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pathpolicy")
    parser.add_argument(
        "command",
        choices=["normalize", "match", "check", "diff", "verify", "enumerate"],
    )
    args = parser.parse_args(argv)
    payload = json.load(sys.stdin)
    try:
        result = _dispatch(args.command, payload)
    except Exception as exc:  # reported as JSON, never a traceback
        result = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
