"""syncmap command line interface.

Usage:
    python -m syncmap manifest DIR
    python -m syncmap diff SRC_DIR DST_DIR [--json]
    python -m syncmap apply MANIFEST SRC_DIR DST_DIR
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import (
    MANIFEST_NAME,
    ApplyError,
    Manifest,
    ManifestError,
    PathError,
    apply,
    build_manifest,
    diff,
)


def _cmd_manifest(args) -> int:
    manifest = build_manifest(args.dir)
    out = args.output
    if out is None:
        out = args.dir.rstrip("/") + "/" + MANIFEST_NAME
    manifest.save(out)
    print(f"wrote {out} ({len(manifest.files)} files)")
    return 0


def _format_op(op: dict) -> str:
    if op["op"] == "MOD":
        blocks = ",".join(str(i) for i in op["blocks"])
        return f"MOD {op['path']} {blocks}".rstrip()
    return f"{op['op']} {op['path']}"


def _cmd_diff(args) -> int:
    src = build_manifest(args.src)
    dst = build_manifest(args.dst)
    ops = diff(src, dst)
    if args.json:
        print(json.dumps(ops, indent=2))
    else:
        for op in ops:
            print(_format_op(op))
    return 0


def _cmd_apply(args) -> int:
    manifest = Manifest.load(args.manifest)
    planned = apply(manifest, args.src, args.dst)
    for op in planned:
        print(_format_op(op))
    print(f"applied {len(planned)} op(s) to {args.dst}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="syncmap", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_manifest = sub.add_parser("manifest", help="build .manifest for DIR")
    p_manifest.add_argument("dir")
    p_manifest.add_argument("-o", "--output", default=None)
    p_manifest.set_defaults(func=_cmd_manifest)

    p_diff = sub.add_parser("diff", help="show ops turning DST_DIR into SRC_DIR")
    p_diff.add_argument("src")
    p_diff.add_argument("dst")
    p_diff.add_argument("--json", action="store_true")
    p_diff.set_defaults(func=_cmd_diff)

    p_apply = sub.add_parser("apply", help="apply MANIFEST to DST_DIR from SRC_DIR")
    p_apply.add_argument("manifest")
    p_apply.add_argument("src")
    p_apply.add_argument("dst")
    p_apply.set_defaults(func=_cmd_apply)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (PathError, ManifestError, ApplyError) as exc:
        print(f"syncmap: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
