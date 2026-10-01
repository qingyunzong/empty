"""Command line interface: python -m netsim run topo.json [--faults f.json] [--steps N] [--seed S] [--check]"""

from __future__ import annotations

import argparse
import json
import sys

from .config import ConfigError, load_faults, load_topo
from .sim import Simulator, check_determinism


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="netsim", description="Deterministic discrete-event network simulator")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run a simulation")
    run.add_argument("topo", help="topology JSON file")
    run.add_argument("--faults", help="faults JSON file", default=None)
    run.add_argument("--steps", type=int, default=10000, help="max events to process")
    run.add_argument("--seed", type=int, default=0, help="RNG seed")
    run.add_argument("--check", action="store_true", help="run twice and assert identical logs")
    return parser


def main(argv=None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.steps < 0:
        print("error: --steps must be >= 0", file=sys.stderr)
        return 2

    try:
        config = load_topo(args.topo)
        faults = load_faults(args.faults, config) if args.faults else None
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.check:
        from .config import Faults

        report = check_determinism(config, faults if faults else Faults(), args.steps, args.seed)
        print(report)
        return 0 if report == "OK" else 1

    sim = Simulator(config, faults, seed=args.seed, max_steps=args.steps)
    summary = sim.run()
    for event in sim.events:
        print(json.dumps(event, sort_keys=True))
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
