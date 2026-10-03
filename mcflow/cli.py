"""JSON command line interface.

Usage:
    python -m mcflow verify INPUT.json
    python -m mcflow repair INPUT.json [--budget N]

verify input : {"network": {...}, "certificate": {...}}
repair input : {"network": {...}, "flow": {...}, "budget": N (optional)}

Exit codes: 0 = certificate valid / repair produced a flow,
            1 = violations found / no feasible repair within budget or at all,
            2 = input or usage error.
"""

from __future__ import annotations

import argparse
import json
import sys

from .network import Network
from .repairer import repair
from .verifier import verify


def _fail(message):
    sys.stderr.write(f"error: {message}\n")
    raise SystemExit(2)


def _load_json(path):
    try:
        text = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    except OSError as exc:
        _fail(f"cannot read {path}: {exc}")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        _fail(f"invalid JSON in {path}: {exc}")


def _load_network(payload):
    if not isinstance(payload, dict) or "network" not in payload:
        _fail("input must be an object containing 'network'")
    try:
        return Network.from_dict(payload["network"])
    except (ValueError, KeyError, TypeError) as exc:
        _fail(f"invalid network: {exc}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="mcflow")
    sub = parser.add_subparsers(dest="command", required=True)
    p_verify = sub.add_parser("verify", help="verify a flow certificate")
    p_verify.add_argument("input", help="JSON input file ('-' for stdin)")
    p_repair = sub.add_parser("repair", help="repair a submitted flow")
    p_repair.add_argument("input", help="JSON input file ('-' for stdin)")
    p_repair.add_argument("--budget", type=int, default=None,
                          help="max number of solver attempts (overrides JSON)")
    args = parser.parse_args(argv)

    payload = _load_json(args.input)
    network = _load_network(payload)

    if args.command == "verify":
        certificate = payload.get("certificate")
        report = verify(network, certificate)
        print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
        return 0 if report.ok else 1

    flow = payload.get("flow", {})
    budget = args.budget if args.budget is not None else payload.get("budget")
    result = repair(network, flow, budget=budget)
    print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    return 0 if result.flow is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
