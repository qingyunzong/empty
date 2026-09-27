"""Atomic apply: sync a target directory to a source directory.

Apply relies only on the source manifest and the source directory.  The
new tree is fully built and verified inside a temporary sibling
directory first; only then is the target swapped atomically via
``os.rename``.  Any failure before the swap leaves the target untouched.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import zlib
from pathlib import Path

from .core import (
    BLOCK_SIZE,
    MANIFEST_NAME,
    Manifest,
    load_manifest,
    validate_relpath,
    write_manifest,
)


class ApplyError(RuntimeError):
    """Raised when apply cannot complete; the target is left unchanged."""


def _copy_verified(src_file: Path, dst_file: Path, entry) -> None:
    """Copy one file block by block, verifying against the manifest."""
    remaining = entry.size
    block_iter = iter(entry.blocks)
    written = 0
    with open(src_file, "rb") as fin, open(dst_file, "wb") as fout:
        while True:
            chunk = fin.read(BLOCK_SIZE)
            if not chunk:
                break
            try:
                expected = next(block_iter)
            except StopIteration:
                raise ApplyError(
                    f"{entry.path}: source has more blocks than the manifest"
                )
            if zlib.adler32(chunk) != expected.adler32:
                raise ApplyError(f"{entry.path}: adler32 mismatch in block")
            if hashlib.sha256(chunk).hexdigest() != expected.sha256:
                raise ApplyError(f"{entry.path}: sha256 mismatch in block")
            fout.write(chunk)
            written += len(chunk)
            remaining -= len(chunk)
    if remaining != 0 or written != entry.size:
        raise ApplyError(f"{entry.path}: size mismatch with manifest")
    if next(block_iter, None) is not None:
        raise ApplyError(f"{entry.path}: manifest has more blocks than the source")
    stat = os.stat(src_file)
    os.utime(dst_file, ns=(stat.st_atime_ns, entry.mtime_ns))


def apply(source_dir, target_dir, manifest_path=None) -> Manifest:
    """Make ``target_dir`` identical to ``source_dir`` (per its manifest).

    Returns the applied manifest.  Raises ApplyError on any inconsistency;
    in that case the target directory is guaranteed to be unmodified.
    """
    source_dir = Path(source_dir)
    target_dir = Path(target_dir)
    if not source_dir.is_dir():
        raise ApplyError(f"source directory does not exist: {source_dir}")
    manifest_file = Path(manifest_path) if manifest_path else source_dir / MANIFEST_NAME
    if not manifest_file.is_file():
        raise ApplyError(f"manifest not found: {manifest_file}")
    manifest = load_manifest(manifest_file)

    target_dir.parent.mkdir(parents=True, exist_ok=True)
    parent = target_dir.parent
    tmp = Path(tempfile.mkdtemp(prefix=".syncmap-new-", dir=parent))
    backup = None
    try:
        for path, entry in manifest.files.items():
            validate_relpath(path)
            src_file = source_dir.joinpath(*path.split("/"))
            if not src_file.is_file():
                raise ApplyError(f"source file missing: {path}")
            dst_file = tmp.joinpath(*path.split("/"))
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            _copy_verified(src_file, dst_file, entry)
        write_manifest(manifest, tmp / MANIFEST_NAME)

        # Atomic swap: rename is atomic on POSIX within one filesystem.
        if target_dir.exists():
            backup = Path(
                tempfile.mkdtemp(prefix=".syncmap-bak-", dir=parent)
            )
            backup.rmdir()
            os.rename(target_dir, backup)
        try:
            os.rename(tmp, target_dir)
        except OSError:
            if backup is not None:
                os.rename(backup, target_dir)
            raise
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return manifest
