"""Command line interface: python -m netsim run topo.json [options]."""
from __future__ import annotations

import argparse
import sys

from .config import ConfigError, load_faults, load_topo, validate_faults
from .sim import Simulator, serialize

EXIT_OK = 0
EXIT_DIVERGED = 1
EXIT_CONFIG = 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="netsim", description="Deterministic single-process network simulator")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a simulation")
    run.add_argument("topo", help="topology JSON file")
    run.add_argument("--faults", default=None, help="fault rules JSON file")
    run.add_argument("--steps", type=int, default=1000,
                     help="maximum number of events to process")
    run.add_argument("--seed", type=int, default=0, help="RNG seed")
    run.add_argument("--output", default=None,
                     help="write JSONL here instead of stdout")
    run.add_argument("--assert-consistency", action="store_true",
                     help="assert pairwise log prefix consistency each step")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.steps <= 0:
            raise ConfigError("--steps must be a positive integer")
        topo = load_topo(args.topo)
        if args.faults:
            faults = load_faults(args.faults, topo)
        else:
            faults = validate_faults({"rules": []}, topo)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG

    sim = Simulator(topo, faults, seed=args.seed,
                    assert_consistency=args.assert_consistency)
    summary = sim.run(args.steps)

    out = open(args.output, "w", encoding="utf-8") if args.output else sys.stdout
    try:
        for record in sim.records:
            out.write(serialize(record) + "\n")
        out.write(serialize(summary) + "\n")
    finally:
        if args.output:
            out.close()

    if sim.divergence is not None:
        a, b = sim.divergence["nodes"]
        print(f"DIVERGE {a} {b}: "
              f"last_log[{a}]={sim.divergence['last_log'][a]!r} "
              f"last_log[{b}]={sim.divergence['last_log'][b]!r}",
              file=sys.stderr)
        return EXIT_DIVERGED
    return EXIT_OK
