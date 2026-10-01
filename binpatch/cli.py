"""Command line entry points for the delta and patch tools."""

from __future__ import annotations

import os
import sys

from .core import PatchError, apply_patch, compute_ops, dumps_patch

USAGE_DELTA = "usage: delta <source.bin> <target.bin> <patch.json>"
USAGE_PATCH = "usage: patch <source.bin> <patch.json> <out.bin>"


def main_delta(argv) -> int:
    if len(argv) != 3:
        print(USAGE_DELTA, file=sys.stderr)
        return 2
    source_path, target_path, patch_path = argv
    try:
        with open(source_path, "rb") as fh:
            source = fh.read()
        with open(target_path, "rb") as fh:
            target = fh.read()
    except OSError as exc:
        print(f"delta: {exc}", file=sys.stderr)
        return 2
    ops, _cost = compute_ops(source, target)
    try:
        with open(patch_path, "w", encoding="utf-8") as fh:
            fh.write(dumps_patch(source, target, ops))
    except OSError as exc:
        print(f"delta: {exc}", file=sys.stderr)
        return 2
    return 0


def main_patch(argv) -> int:
    if len(argv) != 3:
        print(USAGE_PATCH, file=sys.stderr)
        return 2
    source_path, patch_path, out_path = argv
    try:
        with open(source_path, "rb") as fh:
            source = fh.read()
        with open(patch_path, "r", encoding="utf-8") as fh:
            patch_text = fh.read()
        result = apply_patch(source, patch_text)
    except (OSError, UnicodeDecodeError, PatchError) as exc:
        print(f"patch: {exc}", file=sys.stderr)
        try:
            os.remove(out_path)
        except OSError:
            pass
        return 2
    try:
        with open(out_path, "wb") as fh:
            fh.write(result)
    except OSError as exc:
        print(f"patch: {exc}", file=sys.stderr)
        return 2
    return 0
