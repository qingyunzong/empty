"""zpack command line interface.

    python -m zpack encode INPUT OUTPUT
    python -m zpack decode INPUT OUTPUT [--max-output N]

Output is written atomically (temp file + os.replace); any failure exits
with status 6 and leaves no output file behind.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile

from .codec import DEFAULT_MAX_OUTPUT, BudgetError, FormatError, decode, encode

EXIT_FAILURE = 6


def _atomic_write(path: str, data: bytes) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".zpack-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="zpack")
    sub = parser.add_subparsers(dest="command", required=True)
    p_enc = sub.add_parser("encode", help="compress a file")
    p_enc.add_argument("input")
    p_enc.add_argument("output")
    p_dec = sub.add_parser("decode", help="decompress a file")
    p_dec.add_argument("input")
    p_dec.add_argument("output")
    p_dec.add_argument("--max-output", type=int, default=DEFAULT_MAX_OUTPUT,
                       help="decompression budget in bytes")
    args = parser.parse_args(argv)

    try:
        raw = open(args.input, "rb").read()
        if args.command == "encode":
            result = encode(raw)
        else:
            result = decode(raw, max_output=args.max_output)
        _atomic_write(args.output, result)
    except (FormatError, BudgetError, OSError, ValueError) as exc:
        print(f"zpack: error: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    return 0


if __name__ == "__main__":
    sys.exit(main())
