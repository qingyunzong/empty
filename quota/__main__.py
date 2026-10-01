"""CLI: python -m quota apply tx.json --state state.json --out newstate.json"""

from __future__ import annotations

import argparse
import json
import sys

from .core import TxError, apply_tx, validate_state, validate_tx


def _load_json(path, what):
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        print(f"error: cannot read {what} {path!r}: {exc}", file=sys.stderr)
        raise SystemExit(2)
    try:
        return raw, json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"error: {what} {path!r} is not valid JSON: {exc}",
              file=sys.stderr)
        raise SystemExit(2)


def cmd_apply(args):
    state_raw, state = _load_json(args.state, "state file")
    _, tx = _load_json(args.tx, "tx file")
    try:
        validate_state(state)
        validate_tx(tx)
    except TxError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    new_state, first_error_index = apply_tx(state, tx)
    if first_error_index is None:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(new_state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        print(f"ok: applied {len(tx['ops'])} op(s); wrote {args.out}")
        return 0

    # Atomic rollback: emit the original state byte-for-byte.
    with open(args.out, "wb") as fh:
        fh.write(state_raw)
    print(json.dumps({
        "error": "tx rolled back: op failed",
        "first_error_index": first_error_index,
    }), file=sys.stderr)
    return 1


def main(argv=None):
    parser = argparse.ArgumentParser(prog="quota")
    sub = parser.add_subparsers(dest="command", required=True)
    apply_p = sub.add_parser("apply", help="apply a transaction to a state")
    apply_p.add_argument("tx", help="transaction JSON file")
    apply_p.add_argument("--state", required=True, help="input state JSON")
    apply_p.add_argument("--out", required=True, help="output state JSON")
    args = parser.parse_args(argv)
    if args.command == "apply":
        return cmd_apply(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
