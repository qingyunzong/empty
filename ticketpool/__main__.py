"""Command line interface: python -m ticketpool serve cfg.json stream.json --out served.json"""

import argparse
import json
import sys

from .scheduler import serve
from .validate import ValidationError, load_config, load_stream


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="ticketpool",
        description="Deterministic ticket-pool scheduler with group quotas and aging.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve_parser = subparsers.add_parser("serve", help="run the simulation")
    serve_parser.add_argument("cfg", help="path to config JSON")
    serve_parser.add_argument("stream", help="path to ticket stream JSON")
    serve_parser.add_argument("--out", required=True, help="path for the result JSON")
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "serve":
        try:
            cfg = load_config(args.cfg)
            tickets = load_stream(args.stream, cfg)
        except ValidationError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        except FileNotFoundError as exc:
            print(f"error: file not found: {exc.filename}", file=sys.stderr)
            return 2
        except json.JSONDecodeError as exc:
            print(f"error: invalid JSON: {exc}", file=sys.stderr)
            return 2
        except OSError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

        results = serve(cfg, tickets)
        payload = {
            "completed": len(results),
            "tickets": results,
        }
        try:
            with open(args.out, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
                handle.write("\n")
        except OSError as exc:
            print(f"error: cannot write {args.out}: {exc}", file=sys.stderr)
            return 2
        last_end = max((r["end"] for r in results), default=None)
        print(
            f"served {len(results)} ticket(s); last end={last_end}; wrote {args.out}"
        )
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
