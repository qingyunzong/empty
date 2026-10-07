"""JSON command line interface.

Subcommands: ``encode``, ``apply``, ``resume``.  Every invocation prints
a single JSON object on stdout; failures use
``{"ok": false, "error_type": ..., "error": ...}`` and exit status 1.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import applier, encoder
from .errors import DeltaError


def _build_parser():
    parser = argparse.ArgumentParser(prog="deltaup")
    sub = parser.add_subparsers(dest="command", required=True)

    enc = sub.add_parser("encode", help="build a delta stream")
    enc.add_argument("--baseline", required=True)
    enc.add_argument("--target", required=True)
    enc.add_argument("--out", required=True)
    enc.add_argument("--block-size", type=int, default=1 << 20)

    app = sub.add_parser("apply", help="apply a delta stream")
    app.add_argument("--baseline", required=True)
    app.add_argument("--delta", required=True)
    app.add_argument("--target", required=True)
    app.add_argument("--checkpoint")
    app.add_argument("--window-size", type=int, default=applier.WINDOW_SIZE)

    res = sub.add_parser("resume", help="resume an interrupted apply")
    res.add_argument("--baseline", required=True)
    res.add_argument("--delta", required=True)
    res.add_argument("--target", required=True)
    res.add_argument("--checkpoint", required=True)
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "encode":
            result = encoder.encode_delta(
                args.baseline, args.target, args.out, block_size=args.block_size
            )
        elif args.command == "apply":
            result = applier.apply_delta(
                args.baseline,
                args.delta,
                args.target,
                window_size=args.window_size,
                checkpoint_path=args.checkpoint,
            )
        else:
            result = applier.resume_delta(
                args.baseline, args.delta, args.target, args.checkpoint
            )
    except DeltaError as exc:
        print(
            json.dumps(
                {"ok": False, "error_type": type(exc).__name__, "error": str(exc)}
            )
        )
        return 1
    result["ok"] = True
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
