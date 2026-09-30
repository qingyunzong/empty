"""Command line interface for rollsync.

Usage:
    python -m rollsync delta OLD NEW --out PATCH
    python -m rollsync apply OLD PATCH --out OUT

Both subcommands print ``copy_bytes=<n> literal_bytes=<m>`` on stdout.

Exit codes: 0 success, 2 usage/IO error, 5 corrupt patch,
6 sha256 verification failure (target file is left untouched).
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile

from . import (
    HashMismatchError,
    PatchCorruptError,
    apply_patch,
    delta,
    parse_patch,
    summarize,
)

EXIT_OK = 0
EXIT_IO = 2
EXIT_CORRUPT = 5
EXIT_HASH_MISMATCH = 6


def _read(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def _write_atomic(path: str, data: bytes) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".rollsync-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _print_stats(patch: bytes) -> None:
    _, ops = parse_patch(patch)
    copy_bytes, literal_bytes = summarize(ops)
    print(f"copy_bytes={copy_bytes} literal_bytes={literal_bytes}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="rollsync", description="Binary delta sync (rolling Adler-32 + sha256).")
    sub = parser.add_subparsers(dest="command", required=True)

    p_delta = sub.add_parser("delta", help="generate a binary patch OLD -> NEW")
    p_delta.add_argument("old", help="path to the OLD file")
    p_delta.add_argument("new", help="path to the NEW file")
    p_delta.add_argument("--out", required=True, help="patch output path")

    p_apply = sub.add_parser("apply", help="apply a binary patch to OLD")
    p_apply.add_argument("old", help="path to the OLD file")
    p_apply.add_argument("patch", help="path to the PATCH file")
    p_apply.add_argument("--out", required=True, help="result output path")

    args = parser.parse_args(argv)
    try:
        if args.command == "delta":
            old = _read(args.old)
            new = _read(args.new)
            patch = delta(old, new)
            _write_atomic(args.out, patch)
            _print_stats(patch)
            return EXIT_OK
        old = _read(args.old)
        patch = _read(args.patch)
        try:
            result = apply_patch(old, patch)
        except PatchCorruptError as exc:
            print(f"rollsync: corrupt patch: {exc}", file=sys.stderr)
            return EXIT_CORRUPT
        except HashMismatchError as exc:
            print(f"rollsync: sha256 mismatch: {exc}", file=sys.stderr)
            return EXIT_HASH_MISMATCH
        _write_atomic(args.out, result)
        _print_stats(patch)
        return EXIT_OK
    except OSError as exc:
        print(f"rollsync: {exc}", file=sys.stderr)
        return EXIT_IO


if __name__ == "__main__":
    sys.exit(main())
