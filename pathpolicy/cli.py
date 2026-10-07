"""JSON command-line interface.

Usage:  python3.11 -m pathpolicy <op> [json-payload]

The payload is read from the argument if given, else from stdin.  The
result is written to stdout as JSON.  Exit code 0 on success, 1 on
input errors, 2 on usage errors.

Ops:
  normalize     {"path": str}
  match         {"pattern": str, "path": str}
  policy-match  {"policy": policy, "path": str}
  includes      {"left": policy, "right": policy, "budget"?: int,
                 "all_shortest"?: bool}
  equivalent    {"left": policy, "right": policy, "budget"?: int}
  difference    {"left": policy, "right": policy, "budget"?: int,
                 "all_shortest"?: bool}
  verify        {"certificate": cert}
  resume        {"checkpoint": checkpoint, "budget"?: int}

A policy is a pattern string, a list of pattern strings, or
{"allow": [...], "deny": [...]}.
"""

import json
import sys

from .normalize import normalize_path, PathError
from .pattern import parse_pattern, pattern_to_string, PatternError
from .interpreter import match_pattern, match_policy
from .policy import (Policy, InclusionChecker, check_inclusion,
                     check_equivalent, verify_certificate, DEFAULT_BUDGET)


def _op_normalize(payload):
    return {"ok": True, "normalized": normalize_path(payload["path"])}


def _op_match(payload):
    return {"ok": True,
            "match": match_pattern(payload["pattern"], payload["path"])}


def _op_policy_match(payload):
    policy = Policy.from_json(payload["policy"])
    return {"ok": True, "match": match_policy(policy, payload["path"])}


def _op_parse(payload):
    pattern = parse_pattern(payload["pattern"])
    return {"ok": True, "canonical": pattern_to_string(pattern)}


def _op_includes(payload):
    left = Policy.from_json(payload["left"])
    right = Policy.from_json(payload["right"])
    budget = int(payload.get("budget", DEFAULT_BUDGET))
    result = check_inclusion(left, right, budget=budget,
                             all_shortest=bool(payload.get("all_shortest")))
    result["ok"] = True
    return result


def _op_equivalent(payload):
    left = Policy.from_json(payload["left"])
    right = Policy.from_json(payload["right"])
    budget = int(payload.get("budget", DEFAULT_BUDGET))
    result = check_equivalent(left, right, budget=budget)
    result["ok"] = True
    return result


def _op_difference(payload):
    left = Policy.from_json(payload["left"])
    right = Policy.from_json(payload["right"])
    budget = int(payload.get("budget", DEFAULT_BUDGET))
    result = check_inclusion(left, right, budget=budget,
                             all_shortest=bool(payload.get("all_shortest")))
    if result["result"] == "included":
        result["result"] = "empty"
    elif result["result"] == "not_included":
        result["result"] = "nonempty"
    result["ok"] = True
    return result


def _op_verify(payload):
    return {"ok": True, "valid": verify_certificate(payload["certificate"])}


def _op_resume(payload):
    checker = InclusionChecker.from_checkpoint(payload["checkpoint"])
    budget = int(payload.get("budget", DEFAULT_BUDGET))
    result = checker.run(budget=budget,
                         all_shortest=bool(payload.get("all_shortest")))
    result["ok"] = True
    return result


OPS = {
    "normalize": _op_normalize,
    "match": _op_match,
    "policy-match": _op_policy_match,
    "parse": _op_parse,
    "includes": _op_includes,
    "equivalent": _op_equivalent,
    "difference": _op_difference,
    "verify": _op_verify,
    "resume": _op_resume,
}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in OPS:
        sys.stderr.write("usage: python3.11 -m pathpolicy <op> [json]\n"
                         "ops: %s\n" % ", ".join(sorted(OPS)))
        return 2
    op = argv[0]
    try:
        payload = json.loads(argv[1]) if len(argv) > 1 else json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": "invalid JSON: %s" % exc}))
        return 1
    try:
        result = OPS[op](payload)
    except (PathError, PatternError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"ok": False,
                          "error": "%s: %s" % (type(exc).__name__, exc)}))
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0
