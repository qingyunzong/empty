"""Command line interface:

    python -m detrand run spec.json --seed 7 --steps 200 --record run.jsonl
    python -m detrand replay run.jsonl
"""

import argparse
import json
import sys

from .engine import header_line, run_engine
from .errors import DetrandError, DivergeError, InvariantError, ReplayError
from .spec import load_spec


def _write_jsonl(path, lines):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for line in lines:
            fh.write(json.dumps(line, sort_keys=True) + "\n")


def _cmd_run(args):
    spec = load_spec(args.spec)
    engine, records, result = run_engine(spec, args.seed, args.steps)
    lines = [header_line(spec, args.seed, args.steps), *records, result]
    _write_jsonl(args.record, lines)

    if result["status"] == "invariant_violation":
        failure = {
            "seed": args.seed,
            "path": engine.path,
            "last_digest": result["last_digest"],
            "invariant": result["invariant"],
            "step": result["steps_run"] - 1,
            "record": args.record,
        }
        with open(args.failure, "w", encoding="utf-8") as fh:
            json.dump(failure, fh, indent=2, sort_keys=True)
            fh.write("\n")
        raise InvariantError(
            f"invariant violated at step {failure['step']}: "
            f"{result['invariant']} (failure archived to {args.failure})"
        )

    print(
        f"run ok: status={result['status']} steps={result['steps_run']} "
        f"last_digest={result['last_digest']} record={args.record}"
    )
    return 0


def _read_record(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as exc:
        raise ReplayError(f"cannot read record {path!r}: {exc}") from exc
    lines = []
    for lineno, text in enumerate(raw.splitlines(), start=1):
        if not text.strip():
            continue
        try:
            lines.append(json.loads(text))
        except json.JSONDecodeError as exc:
            raise ReplayError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
    if not lines:
        raise ReplayError(f"{path}: empty record")
    header = lines[0]
    if not isinstance(header, dict) or header.get("type") != "header":
        raise ReplayError(f"{path}: first line must be a header")
    for key in ("seed", "steps", "spec"):
        if key not in header:
            raise ReplayError(f"{path}: header missing {key!r}")
    return header, lines[1:]


def _cmd_replay(args):
    header, body = _read_record(args.record)
    recorded_steps = [line for line in body if line.get("type") == "step"]
    recorded_result = next(
        (line for line in reversed(body) if line.get("type") == "result"), None
    )
    if recorded_result is None:
        raise ReplayError(f"{args.record}: missing result line")

    _, records, result = run_engine(header["spec"], header["seed"], header["steps"])

    if len(records) != len(recorded_steps):
        raise DivergeError(
            f"step count differs: recorded={len(recorded_steps)} "
            f"replayed={len(records)}"
        )
    for expected, actual in zip(recorded_steps, records):
        for key in ("step", "op", "args", "state", "digest"):
            if expected.get(key) != actual[key]:
                raise DivergeError(
                    f"step {actual['step']}: field {key!r} differs: "
                    f"recorded={expected.get(key)!r} replayed={actual[key]!r}"
                )
    for key in ("status", "steps_run", "last_digest"):
        if recorded_result.get(key) != result[key]:
            raise DivergeError(
                f"result field {key!r} differs: "
                f"recorded={recorded_result.get(key)!r} replayed={result[key]!r}"
            )

    if result["status"] == "invariant_violation":
        raise InvariantError(
            f"reproduced invariant violation at step "
            f"{result['steps_run'] - 1}: {result.get('invariant')}"
        )
    print(
        f"replay ok: status={result['status']} steps={result['steps_run']} "
        f"last_digest={result['last_digest']}"
    )
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="detrand",
        description="Deterministic random operation streams for state-machine testing.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="generate an operation stream and record it")
    run.add_argument("spec", help="path to the state-machine spec (JSON)")
    run.add_argument("--seed", type=int, default=0, help="master seed (default: 0)")
    run.add_argument(
        "--steps", type=int, default=100, help="max steps to generate (default: 100)"
    )
    run.add_argument(
        "--record", default="run.jsonl", help="output JSONL record (default: run.jsonl)"
    )
    run.add_argument(
        "--failure",
        default="failure.json",
        help="failure archive path (default: failure.json)",
    )
    run.set_defaults(func=_cmd_run)

    replay = sub.add_parser("replay", help="replay and verify a recorded run")
    replay.add_argument("record", help="path to a JSONL record produced by 'run'")
    replay.set_defaults(func=_cmd_replay)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except DetrandError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return exc.exit_code
