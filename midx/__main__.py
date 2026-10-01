"""CLI: python -m midx build|verify|root."""

import argparse
import sys

from . import core


def main(argv=None):
    parser = argparse.ArgumentParser(prog="midx")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build", help="build index for a file")
    p_build.add_argument("file")
    p_build.add_argument("--block-size", type=int, default=65536)
    p_build.add_argument("-o", "--output", default=None)

    p_verify = sub.add_parser("verify", help="verify a file against its index")
    p_verify.add_argument("file")
    p_verify.add_argument("--index", default=None)
    p_verify.add_argument("--offset", type=int, default=0)
    p_verify.add_argument("--length", type=int, default=None)

    p_root = sub.add_parser("root", help="print the root hash of an index")
    p_root.add_argument("index")

    args = parser.parse_args(argv)
    try:
        if args.cmd == "build":
            index, path = core.build(args.file, args.block_size, args.output)
            print(f"index: {path}")
            print(f"blocks: {index.leaf_count} x {index.block_size} bytes")
            print(f"root: {index.root.hex()}")
            return 0
        if args.cmd == "verify":
            index_path = args.index or args.file + ".index"
            index = core.load_index(index_path)
            bad = core.verify_range(index, args.file, args.offset,
                                    args.length)
            if bad:
                print(f"BAD first bad block: {bad[0]} "
                      f"(all bad: {bad})")
                return 1
            print("OK")
            return 0
        if args.cmd == "root":
            index = core.load_index(args.index)
            print(index.root.hex())
            return 0
    except IndexError as exc:
        print(f"index error: {exc}", file=sys.stderr)
        return 4
    except OSError as exc:
        print(f"io error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
