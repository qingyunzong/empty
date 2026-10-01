"""CLI: python -m ticketpool serve cfg.json stream.json --out served.json"""

from __future__ import annotations

import argparse
import json
import sys

from .sim import ValidationError, serve


def _load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="ticketpool")
    sub = parser.add_subparsers(dest="command", required=True)
    serve_parser = sub.add_parser("serve", help="run the scheduler simulation")
    serve_parser.add_argument("cfg", help="config JSON: workers, aging_step, boost, base_quota")
    serve_parser.add_argument("stream", help="stream JSON: tickets sorted by arrival")
    serve_parser.add_argument("--out", required=True, help="output JSON path")
    args = parser.parse_args(argv)

    try:
        cfg = _load_json(args.cfg)
        stream = _load_json(args.stream)
        result = serve(cfg, stream)
    except ValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, sort_keys=True)
        handle.write("\n")
    summary = result["summary"]
    print(
        f"completed={summary['completed']} makespan={summary['makespan']} -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
