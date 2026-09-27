"""Command line interface for rollsync."""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from . import (EXIT_CORRUPT, EXIT_IO, EXIT_OK, EXIT_CHECKSUM,
               ChecksumMismatchError, CorruptPatchError, apply_patch, delta,
               serialize_patch)


def _read(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def _write(path: str, data: bytes) -> None:
    with open(path, "wb") as handle:
        handle.write(data)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rollsync",
        description="Generate and apply binary delta patches.")
    sub = parser.add_subparsers(dest="command", required=True)

    delta_parser = sub.add_parser("delta", help="write a patch OLD -> NEW")
    delta_parser.add_argument("old", help="path to the old (basis) file")
    delta_parser.add_argument("new", help="path to the new (target) file")
    delta_parser.add_argument("--out", required=True, help="patch output path")

    apply_parser = sub.add_parser("apply", help="apply a patch to OLD")
    apply_parser.add_argument("old", help="path to the old (basis) file")
    apply_parser.add_argument("patch", help="path to the patch file")
    apply_parser.add_argument("--out", required=True, help="result output path")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "delta":
            old = _read(args.old)
            new = _read(args.new)
            patch = delta(old, new)
            _write(args.out, serialize_patch(patch))
            return EXIT_OK

        old = _read(args.old)
        patch_data = _read(args.patch)
        result, copy_bytes, literal_bytes = apply_patch(old, patch_data)
        # Only write the target after every verification has passed, so a
        # failed apply never touches the destination file.
        _write(args.out, result)
        print(f"copy={copy_bytes} literal={literal_bytes}")
        return EXIT_OK
    except ChecksumMismatchError as exc:
        print(f"rollsync: checksum mismatch: {exc}", file=sys.stderr)
        return EXIT_CHECKSUM
    except CorruptPatchError as exc:
        print(f"rollsync: corrupt patch: {exc}", file=sys.stderr)
        return EXIT_CORRUPT
    except OSError as exc:
        print(f"rollsync: io error: {exc}", file=sys.stderr)
        return EXIT_IO


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
