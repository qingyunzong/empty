"""JSON CLI for the delta update tool.

Usage:
    python3.11 -m deltaupd encode --baseline B --target T --output U
    python3.11 -m deltaupd apply  --baseline B --update U --target T \
        --state-dir S [--force] [--max-events N]

All results are printed as a single JSON object on stdout.  Exit code is 0
on success/need_more and 1 on any error; a failed apply never modifies an
existing target file.
"""

import argparse
import json
import sys

from .applier import Applier
from .encoder import encode_file
from .errors import UpdateError


def _cmd_encode(args) -> int:
    size = encode_file(args.baseline, args.target, args.output,
                       args.block_size)
    print(json.dumps({"status": "encoded", "update_size": size}))
    return 0


def _cmd_apply(args) -> int:
    if args.force:
        import os
        for name in ("checkpoint.json", "output.tmp"):
            try:
                os.unlink(os.path.join(args.state_dir, name))
            except FileNotFoundError:
                pass
    try:
        with Applier(args.baseline, args.update, args.target, args.state_dir,
                     interrupt_after=args.max_events) as applier:
            result = applier.run()
    except UpdateError as exc:
        print(json.dumps({"status": "error",
                          "error_type": type(exc).__name__,
                          "error": str(exc)}))
        return 1
    print(json.dumps(result))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="deltaupd")
    sub = parser.add_subparsers(dest="command", required=True)

    enc = sub.add_parser("encode", help="build an update stream")
    enc.add_argument("--baseline", required=True)
    enc.add_argument("--target", required=True)
    enc.add_argument("--output", required=True)
    enc.add_argument("--block-size", type=int, default=1 << 20)
    enc.set_defaults(func=_cmd_encode)

    app = sub.add_parser("apply", help="apply an update stream")
    app.add_argument("--baseline", required=True)
    app.add_argument("--update", required=True)
    app.add_argument("--target", required=True)
    app.add_argument("--state-dir", required=True)
    app.add_argument("--force", action="store_true",
                     help="discard any existing checkpoint and start over")
    app.add_argument("--max-events", type=int, default=None,
                     help="stop after N verified boundaries (testing hook)")
    app.set_defaults(func=_cmd_apply)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
