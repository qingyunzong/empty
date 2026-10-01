import argparse
import sys

from .core import EventError, run


def build_parser():
    parser = argparse.ArgumentParser(
        prog="wmagg",
        description="Watermark-based tumbling-window per-key aggregation.",
    )
    parser.add_argument("--input", required=True, help="input JSONL path")
    parser.add_argument("--out", required=True, help="output JSONL path")
    parser.add_argument(
        "--late", default="late.jsonl", help="late-event JSONL path"
    )
    parser.add_argument("--window", type=int, required=True, help="window length W (ms)")
    parser.add_argument(
        "--lateness", type=int, required=True, help="allowed out-of-orderness S (ms)"
    )
    parser.add_argument(
        "--idle-timeout", type=int, required=True, help="idle timeout I (ms)"
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.window <= 0 or args.lateness < 0 or args.idle_timeout < 0:
        print(
            "wmagg: error: require --window > 0, --lateness >= 0, --idle-timeout >= 0",
            file=sys.stderr,
        )
        return 2
    try:
        run(
            args.input,
            args.out,
            args.late,
            args.window,
            args.lateness,
            args.idle_timeout,
        )
    except EventError as exc:
        print(f"wmagg: error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"wmagg: error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
