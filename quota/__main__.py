"""CLI: python -m quota apply tx.json --state state.json --out newstate.json

Exit codes:
  0  transaction applied; new state written to --out
  1  an op failed; original state bytes written to --out, JSON error on stderr
  2  validation error (bad amount, cyclic path, missing root, bad JSON, ...)
"""

import argparse
import json
import sys

from .core import ValidationError, apply_tx, validate_node, validate_tx


def _cmd_apply(args):
    try:
        with open(args.state, "rb") as fh:
            state_bytes = fh.read()
    except OSError as exc:
        print(f"error: cannot read state file: {exc}", file=sys.stderr)
        return 2
    try:
        with open(args.tx, "rb") as fh:
            tx_bytes = fh.read()
    except OSError as exc:
        print(f"error: cannot read tx file: {exc}", file=sys.stderr)
        return 2
    try:
        state = json.loads(state_bytes)
    except json.JSONDecodeError as exc:
        print(f"error: state file is not valid JSON: {exc}", file=sys.stderr)
        return 2
    try:
        tx = json.loads(tx_bytes)
    except json.JSONDecodeError as exc:
        print(f"error: tx file is not valid JSON: {exc}", file=sys.stderr)
        return 2
    try:
        validate_node(state)  # missing/malformed root -> exit 2
        validate_tx(tx)
    except ValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    new_state, first_error_index, message = apply_tx(state, tx)
    if first_error_index is not None:
        # Atomic rollback: emit the original state bytes verbatim.
        try:
            with open(args.out, "wb") as fh:
                fh.write(state_bytes)
        except OSError as exc:
            print(f"error: cannot write out file: {exc}", file=sys.stderr)
            return 2
        print(
            json.dumps(
                {"error": message, "first_error_index": first_error_index},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1

    try:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(new_state, fh, indent=2, sort_keys=True, ensure_ascii=False)
            fh.write("\n")
    except OSError as exc:
        print(f"error: cannot write out file: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"status": "ok", "ops_applied": len(tx["ops"])}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="quota")
    sub = parser.add_subparsers(dest="command", required=True)
    apply_parser = sub.add_parser("apply", help="apply a transaction to a state tree")
    apply_parser.add_argument("tx", help="transaction JSON file")
    apply_parser.add_argument("--state", required=True, help="input state JSON file")
    apply_parser.add_argument("--out", required=True, help="output state JSON file")
    args = parser.parse_args(argv)
    if args.command == "apply":
        return _cmd_apply(args)
    parser.error(f"unknown command {args.command!r}")


if __name__ == "__main__":
    sys.exit(main())
