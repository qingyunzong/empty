"""Command line interface: ``python -m bmc check model.json --bound 12 --out trace.json``."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .engine import ERROR, check
from .model import ModelError, load_model


def _fail(message: str) -> int:
    """Invalid model/input: one-line JSON on stderr, exit code 2."""
    print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
    return 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="bmc",
        description="Bounded model checker for integer transition systems.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    check_parser = sub.add_parser("check", help="run bounded BFS model checking")
    check_parser.add_argument("model", help="path to the model JSON file")
    check_parser.add_argument(
        "--bound",
        type=int,
        default=10,
        help="maximum BFS depth to explore (default: 10)",
    )
    check_parser.add_argument(
        "--out",
        default=None,
        help="also write the result JSON to this file",
    )
    args = parser.parse_args(argv)

    if args.bound < 0:
        return _fail(f"--bound must be >= 0, got {args.bound}")

    try:
        text = Path(args.model).read_text(encoding="utf-8")
    except OSError as exc:
        return _fail(f"cannot read model file {args.model!r}: {exc}")

    try:
        model = load_model(text)
    except ModelError as exc:
        return _fail(str(exc))

    result = check(model, args.bound)
    payload = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out is not None:
        try:
            Path(args.out).write_text(payload + "\n", encoding="utf-8")
        except OSError as exc:
            return _fail(f"cannot write output file {args.out!r}: {exc}")
    print(payload)
    return 1 if result["status"] == ERROR else 0


if __name__ == "__main__":
    sys.exit(main())
