"""Command line interface: python -m leasesim run OPS.json [--out STATE.json]"""

from __future__ import annotations

import argparse
import json
import sys

from .simulator import LeaseSimError, run


def _load_ops(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as exc:
        raise LeaseSimError(f"cannot read {path!r}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise LeaseSimError(f"invalid JSON in {path!r}: {exc}") from exc


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m leasesim",
        description="Deterministic multi-resource lease simulator.")
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run", help="run a simulation from an ops JSON file")
    run_parser.add_argument("ops", help="path to the ops JSON file")
    run_parser.add_argument("--out", help="write the resulting state JSON to this path")
    args = parser.parse_args(argv)

    if args.command == "run":
        try:
            config = _load_ops(args.ops)
            result = run(config)
        except LeaseSimError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        text = json.dumps(result, indent=2, sort_keys=True) + "\n"
        if args.out:
            try:
                with open(args.out, "w", encoding="utf-8") as fh:
                    fh.write(text)
            except OSError as exc:
                print(f"error: cannot write {args.out!r}: {exc}", file=sys.stderr)
                return 2
        else:
            sys.stdout.write(text)
        return 0
    return 2
