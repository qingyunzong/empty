"""Command line interface for syncmap."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .apply import ApplyError, apply
from .core import (
    MANIFEST_NAME,
    PathError,
    build_manifest,
    diff,
    write_manifest,
)


def _cmd_manifest(args) -> int:
    manifest = build_manifest(args.directory)
    out = Path(args.output) if args.output else Path(args.directory) / MANIFEST_NAME
    write_manifest(manifest, out)
    print(f"wrote {out} ({len(manifest.files)} files)")
    return 0


def _cmd_diff(args) -> int:
    src = build_manifest(args.source)
    tgt = build_manifest(args.target)
    ops = diff(src, tgt)
    for op in ops:
        print(op.format())
    if args.exit_code and ops:
        return 1
    return 0


def _cmd_apply(args) -> int:
    apply(args.source, args.target, manifest_path=args.manifest)
    print(f"applied: {args.target} now matches {args.source}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="syncmap",
        description="Diff and sync two local directories using 64 KiB block "
        "adler32/sha256 manifests.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_manifest = sub.add_parser("manifest", help="generate DIR/.manifest")
    p_manifest.add_argument("directory")
    p_manifest.add_argument("-o", "--output", help="output path (default: DIR/.manifest)")
    p_manifest.set_defaults(func=_cmd_manifest)

    p_diff = sub.add_parser("diff", help="print ADD/DEL/MOD ops between two dirs")
    p_diff.add_argument("source")
    p_diff.add_argument("target")
    p_diff.add_argument(
        "--exit-code",
        action="store_true",
        help="exit with status 1 when differences are found",
    )
    p_diff.set_defaults(func=_cmd_diff)

    p_apply = sub.add_parser(
        "apply", help="atomically sync TARGET to SOURCE using SOURCE/.manifest"
    )
    p_apply.add_argument("source")
    p_apply.add_argument("target")
    p_apply.add_argument(
        "-m", "--manifest", help="manifest path (default: SOURCE/.manifest)"
    )
    p_apply.set_defaults(func=_cmd_apply)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ApplyError, PathError, OSError, ValueError) as exc:
        print(f"syncmap: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
