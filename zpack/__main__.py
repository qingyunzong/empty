"""Command line interface: python -m zpack compress|decompress IN OUT."""

import argparse
import os
import sys
import tempfile

from . import BudgetError, FormatError, ZpackError, compress, decompress

EXIT_ERROR = 6
DEFAULT_MAX_OUTPUT = 1 << 30  # 1 GiB decompression bomb guard


def _atomic_write(path, data):
    """Write ``data`` to ``path`` atomically (temp file + rename)."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".zpack-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(prog="zpack")
    sub = parser.add_subparsers(dest="command", required=True)

    p_compress = sub.add_parser("compress", help="compress a file")
    p_compress.add_argument("input")
    p_compress.add_argument("output")

    p_decompress = sub.add_parser("decompress", help="decompress a file")
    p_decompress.add_argument("input")
    p_decompress.add_argument("output")
    p_decompress.add_argument(
        "--max-size",
        type=int,
        default=DEFAULT_MAX_OUTPUT,
        help="maximum allowed decompressed size in bytes (default: %(default)s)",
    )

    args = parser.parse_args(argv)
    try:
        with open(args.input, "rb") as handle:
            raw = handle.read()
        if args.command == "compress":
            result = compress(raw)
        else:
            if args.max_size < 0:
                raise ZpackError("--max-size must be non-negative")
            result = decompress(raw, max_output=args.max_size)
        _atomic_write(args.output, result)
    except (ZpackError, OSError) as exc:
        print("zpack: error: %s" % exc, file=sys.stderr)
        return EXIT_ERROR
    return 0


if __name__ == "__main__":
    sys.exit(main())
