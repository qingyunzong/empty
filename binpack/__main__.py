"""CLI: python -m binpack pack items.json --bins bins.json --out plan.json \
--mode exact|firstfit

Exit codes:
    0  input valid; plan.json written (status OK / INFEASIBLE / TOO_LARGE)
    2  invalid input (non-positive dimensions, count < 0, bad mode,
       malformed JSON, missing fields) or I/O failure
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import InputError, pack, parse_bins, parse_items


def _load_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        raise InputError(f"cannot read {path}: {exc}") from None
    except json.JSONDecodeError as exc:
        raise InputError(f"invalid JSON in {path}: {exc}") from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m binpack",
        description="Deterministic 2D rectangle bin packing.")
    sub = parser.add_subparsers(dest="command", required=True)
    pack_parser = sub.add_parser("pack", help="pack items into bins")
    pack_parser.add_argument("items", help="path to items JSON file")
    pack_parser.add_argument("--bins", required=True,
                             help="path to bins JSON file")
    pack_parser.add_argument("--out", required=True,
                             help="path to write the plan JSON")
    pack_parser.add_argument("--mode", required=True,
                             choices=("exact", "firstfit"),
                             help="packing mode")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        items = parse_items(_load_json(args.items))
        bins = parse_bins(_load_json(args.bins))
        plan = pack(items, bins, args.mode)
        plan["mode"] = args.mode
        payload = json.dumps(plan, indent=2, sort_keys=True) + "\n"
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload)
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
