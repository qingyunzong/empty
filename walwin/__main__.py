"""CLI: python -m walwin --in e.jsonl --dir state --win 60000"""
import argparse
import sys

from .core import run


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="walwin",
        description="WAL-backed sliding-window sum over {seq,key,ts,delta} records.",
    )
    parser.add_argument("--in", dest="input", required=True,
                        help="input JSONL file of {seq,key,ts,delta} records")
    parser.add_argument("--dir", dest="state_dir", required=True,
                        help="state directory holding wal.log and snapshot.json")
    parser.add_argument("--win", dest="win", type=int, required=True,
                        help="window width in milliseconds")
    args = parser.parse_args(argv)
    return run(args.input, args.state_dir, args.win)


if __name__ == "__main__":
    sys.exit(main())
