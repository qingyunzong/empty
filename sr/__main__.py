"""CLI: python -m sr run trace.json

Executes a trace of events against the SR simulator and prints the delivery
sequence and retransmission count as JSON.

Trace format:
{
  "window_size": 4,          # optional, default 4
  "seq_space": 8,            # optional, default 8
  "timeout": 10,             # optional, default 10
  "events": [
    {"op": "send", "data": "f0"},
    {"op": "lose", "seq": 1},
    {"op": "deliver", "seq": 0},
    {"op": "deliver_ack", "seq": 0},
    {"op": "lose_ack", "seq": 2},
    {"op": "advance", "t": 10}
  ]
}
"""

import argparse
import json
import sys

from .simulator import Simulator


def run_trace(trace: dict) -> dict:
    sim = Simulator(
        window_size=trace.get("window_size", 4),
        seq_space=trace.get("seq_space", 8),
        timeout=trace.get("timeout", 10),
    )
    for i, event in enumerate(trace.get("events", [])):
        op = event.get("op")
        try:
            if op == "send":
                sim.send(event["data"])
            elif op == "advance":
                sim.advance(event["t"])
            elif op == "lose":
                sim.lose(event["seq"])
            elif op == "deliver":
                sim.deliver(event["seq"])
            elif op == "lose_ack":
                sim.lose_ack(event["seq"])
            elif op == "deliver_ack":
                sim.deliver_ack(event["seq"])
            else:
                raise ValueError(f"unknown op {op!r}")
        except (KeyError, RuntimeError, ValueError) as exc:
            raise SystemExit(f"event {i} ({event!r}) failed: {exc}")
    return sim.result()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="sr", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run", help="run a trace file")
    run_p.add_argument("trace", help="path to trace JSON file")
    args = parser.parse_args(argv)

    if args.command == "run":
        with open(args.trace, "r", encoding="utf-8") as fh:
            trace = json.load(fh)
        result = run_trace(trace)
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
