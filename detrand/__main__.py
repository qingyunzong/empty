"""CLI: python -m detrand run spec.json --seed 7 --steps 200 --record run.jsonl
        python -m detrand replay run.jsonl
"""

from __future__ import annotations

import argparse
import sys

from . import core
from .errors import DetrandError


def build_parser():
    parser = argparse.ArgumentParser(
        prog="detrand",
        description="Deterministic random operation streams for state-machine testing.")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="generate an op stream and record it as JSONL")
    run.add_argument("spec", help="path to the state-machine spec (JSON)")
    run.add_argument("--seed", type=int, required=True, help="integer seed")
    run.add_argument("--steps", type=int, required=True, help="number of steps")
    run.add_argument("--record", required=True, help="output JSONL record path")
    run.add_argument("--failure", default="failure.json",
                     help="failure archive path (default: failure.json)")

    replay = sub.add_parser("replay", help="re-execute a record and verify digests")
    replay.add_argument("record", help="JSONL record produced by 'run'")
    replay.add_argument("--failure", default="failure.json",
                        help="failure archive path (default: failure.json)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.command == "run":
            core.run_command(args.spec, args.seed, args.steps, args.record, args.failure)
        else:
            core.replay_command(args.record, args.failure)
    except DetrandError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return exc.exit_code
    return 0


if __name__ == "__main__":
    sys.exit(main())
