"""Command line interface: python -m binpack pack items.json --bins bins.json
--out plan.json --mode exact|firstfit"""

import argparse
import json
import sys

from . import core


def _load_json(path, what):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        raise core.InputError(f"cannot read {what} file {path!r}: {exc}") from None
    except json.JSONDecodeError as exc:
        raise core.InputError(f"invalid JSON in {what} file {path!r}: {exc}") from None


def build_parser():
    parser = argparse.ArgumentParser(prog="binpack")
    sub = parser.add_subparsers(dest="command", required=True)
    pack = sub.add_parser("pack", help="pack items into bins")
    pack.add_argument("items", help="JSON file with items [{id,w,h,rotate}]")
    pack.add_argument("--bins", required=True, help="JSON file with bins [{id,W,H,count}]")
    pack.add_argument("--out", required=True, help="output plan JSON file")
    pack.add_argument("--mode", required=True, choices=["exact", "firstfit"])
    return parser


def cmd_pack(args):
    items = core.parse_items(_load_json(args.items, "items"))
    bins = core.parse_bins(_load_json(args.bins, "bins"))

    if args.mode == "exact":
        status, placements, slots = core.exact(items, bins)
    else:
        placements, slots = core.firstfit(items, bins)
        status = "OK" if placements is not None else "INFEASIBLE"

    plan = core.build_plan(status, placements, slots, items)
    plan["mode"] = args.mode
    try:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(plan, fh, indent=2, sort_keys=True)
            fh.write("\n")
    except OSError as exc:
        raise core.InputError(f"cannot write output file {args.out!r}: {exc}") from None
    print(f"{args.mode}: {status} -> {args.out}")
    return 0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "pack":
            return cmd_pack(args)
    except core.InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    parser.error("unreachable")


if __name__ == "__main__":
    sys.exit(main())
