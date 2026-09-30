"""CLI: python -m nakproto run loss_script.json [--trace]"""

from __future__ import annotations

import argparse
import json
import sys

from .config import ConfigError, load_config
from .protocol import run_simulation


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="nakproto", description="Receiver-NAK retransmission protocol simulator"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run", help="run a loss script")
    run_p.add_argument("script", help="path to the loss script JSON file")
    run_p.add_argument(
        "--trace", action="store_true", help="include the per-tick event trace"
    )
    args = parser.parse_args(argv)

    if args.command == "run":
        try:
            config = load_config(args.script)
        except ConfigError as exc:
            print(f"ConfigError: {exc}", file=sys.stderr)
            return 2
        result = run_simulation(config)
        output = {
            "status": result["status"],
            "delivered": result["delivered"],
            "nak_log": result["nak_log"],
        }
        if args.trace:
            output["trace"] = result["trace"]
        print(json.dumps(output, indent=2))
        return 0 if result["status"] == "OK" else 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
