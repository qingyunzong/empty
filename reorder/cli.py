"""JSON-lines CLI for the reorder engine.

Usage:
  python3.11 -m reorder.cli [--modulus M] [--window W] [--journal PATH] [script.jsonl]

Reads one JSON command per line (stdin or script file), writes one JSON
response per line.  Commands:
  {"cmd":"recv","frame":{...}}   -> receive a frame
  {"cmd":"poll","max":N}         -> drain up to N business deliveries
  {"cmd":"crash"}                -> simulate process death
  {"cmd":"recover"}              -> rebuild state from the journal
  {"cmd":"status"}               -> per-stream receiver state
  {"cmd":"conflicts"}            -> retained conflict evidence
"""
from __future__ import annotations

import argparse
import json
import sys

from .engine import Engine


def make_engine(args) -> Engine:
    return Engine(modulus=args.modulus, window=args.window,
                  journal_path=args.journal)


def handle(engine: Engine, command: dict) -> dict:
    cmd = command.get("cmd")
    if cmd == "recv":
        return {"ok": True, "result": engine.receive(command["frame"])}
    if cmd == "poll":
        return {"ok": True, "delivered": engine.poll(command.get("max"))}
    if cmd == "crash":
        engine.crash()
        return {"ok": True}
    if cmd == "recover":
        engine.recover()
        return {"ok": True}
    if cmd == "status":
        return {"ok": True, "streams": engine.status()}
    if cmd == "conflicts":
        return {"ok": True, "conflicts": engine.conflicts()}
    return {"ok": False, "error": f"unknown cmd {cmd!r}"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="reorder.cli")
    parser.add_argument("--modulus", type=int, default=1 << 16)
    parser.add_argument("--window", type=int, default=1 << 8)
    parser.add_argument("--journal", default=None)
    parser.add_argument("script", nargs="?", default=None,
                        help="JSONL command file (default: stdin)")
    args = parser.parse_args(argv)

    engine = make_engine(args)
    source = open(args.script, encoding="utf-8") if args.script else sys.stdin
    try:
        for line in source:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                response = handle(engine, json.loads(line))
            except Exception as exc:  # keep the stream going, report the error
                response = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            sys.stdout.write(json.dumps(response, sort_keys=True) + "\n")
            sys.stdout.flush()
    finally:
        if source is not sys.stdin:
            source.close()
        engine.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
