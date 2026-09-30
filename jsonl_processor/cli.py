"""Command line interface: process / crash / recover / dead-letters / state."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import core


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--input", required=True, help="path to the JSONL input file")
    parser.add_argument("--workdir", required=True, help="working directory for outputs/state")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jsonl-processor",
        description="Process JSONL records with atomic outputs, checkpointing and recovery.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_process = sub.add_parser("process", help="run a fresh processing pass")
    _add_common(p_process)
    p_process.set_defaults(func=_cmd_process)

    p_crash = sub.add_parser("crash", help="run and simulate a crash at a given point")
    _add_common(p_crash)
    p_crash.add_argument("--at", required=True, choices=core.CRASH_POINTS, dest="crash_point")
    p_crash.add_argument("--seq", required=True, type=int, help="record sequence number to crash on")
    p_crash.set_defaults(func=_cmd_crash)

    p_recover = sub.add_parser("recover", help="resume an interrupted run")
    _add_common(p_recover)
    p_recover.set_defaults(func=_cmd_recover)

    p_dead = sub.add_parser("dead-letters", help="list dead-lettered records")
    p_dead.add_argument("--workdir", required=True)
    p_dead.set_defaults(func=_cmd_dead_letters)

    p_state = sub.add_parser("state", help="show current state and checkpoint")
    p_state.add_argument("--workdir", required=True)
    p_state.set_defaults(func=_cmd_state)

    return parser


def _print_summary(results) -> None:
    counts = {}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    print(json.dumps({"records": len(results), "by_status": counts}, sort_keys=True))


def _cmd_process(args) -> int:
    results = core.run(args.input, args.workdir)
    _print_summary(results)
    return 0


def _cmd_crash(args) -> int:
    try:
        core.run(args.input, args.workdir, crash_point=args.crash_point, crash_seq=args.seq)
    except core.SimulatedCrash as exc:
        print(f"CRASH simulated: {exc}", file=sys.stderr)
        return 3
    print("error: crash point was never reached", file=sys.stderr)
    return 2


def _cmd_recover(args) -> int:
    results = core.run(args.input, args.workdir, recover=True)
    _print_summary(results)
    return 0


def _cmd_dead_letters(args) -> int:
    wd = core.Workdir(args.workdir)
    if not wd.state_path.is_file():
        raise core.ProcessorError(f"no state file in {wd.path}: unknown workdir")
    entries = []
    if wd.dead_letters_path.is_file():
        for line in wd.dead_letters_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                entries.append(json.loads(line))
    print(json.dumps({"dead_letters": entries, "count": len(entries)}, ensure_ascii=False))
    return 0


def _cmd_state(args) -> int:
    wd = core.Workdir(args.workdir)
    state = wd.read_state()
    max_seq = wd.read_checkpoint()
    print(json.dumps({"state": state, "max_seq": max_seq}))
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except core.ProcessorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
