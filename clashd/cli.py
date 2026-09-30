"""Command line interface: python -m clashd decide rules.json req.json"""

import argparse
import json
import sys

from .errors import PolicyError
from .policy import compile_policy, decide


def _load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as exc:
        raise PolicyError("E_IO", f"cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise PolicyError("E_JSON", f"invalid JSON in {path}: {exc}") from exc


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="clashd",
        description="Compile rule sets into deterministic decisions.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    decide_parser = sub.add_parser("decide", help="decide one request")
    decide_parser.add_argument("rules", help="path to rules JSON file")
    decide_parser.add_argument("request", help="path to request JSON file")
    args = parser.parse_args(argv)

    try:
        config = _load_json(args.rules)
        request = _load_json(args.request)
        policy = compile_policy(config)
        result = decide(policy, request)
    except PolicyError as exc:
        json.dump(exc.to_dict(), sys.stderr, indent=2)
        sys.stderr.write("\n")
        return 2
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0
