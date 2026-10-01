"""syncmap: content-addressed two-directory diff/apply tool.

Model
-----
* Files are split into 64 KiB blocks.  Each block carries a weak
  ``adler32`` checksum and a strong ``sha256`` checksum.
* A ``.manifest`` describes a directory: for every file its POSIX
  relative UTF-8 path, size, mtime_ns and block table.  Empty files
  have zero blocks.
* ``diff(src, dst)`` describes how to turn *dst* into *src*:
  ``ADD`` (only in src), ``DEL`` (only in dst), ``MOD`` (present in
  both, content differs).  ``MOD`` lists only the changed block
  numbers.
* Block matching: a target block matches a source block when the
  weak ``adler32`` is equal *and* the strong ``sha256`` confirms it
  (weak first, then strong -- an adler32 collision alone never
  counts as a match).  When several source blocks share the same
  strong checksum the winner is the lexicographically smallest path,
  then the smallest block index.
* ``apply`` uses only the manifest and the source directory.  All
  source data is verified and staged in a temporary directory first;
  the target is committed with atomic ``os.replace`` only after
  everything checks out, so a failure leaves the target untouched.
"""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import shutil
import stat
import tempfile
import zlib
from dataclasses import dataclass, field

BLOCK_SIZE = 64 * 1024
MANIFEST_NAME = ".manifest"
MANIFEST_FORMAT = "syncmap-manifest"
MANIFEST_VERSION = 1
STAGING_PREFIX = ".syncmap-tmp-"


class PathError(Exception):
    """Illegal path: absolute, escaping via '..', or not valid UTF-8."""


class ManifestError(Exception):
    """Malformed or unsupported manifest."""


class ApplyError(Exception):
    """apply() cannot proceed; the target directory is left untouched."""


# ---------------------------------------------------------------------------
# paths


def validate_relpath(path: str) -> str:
    """Validate a POSIX relative UTF-8 path, returning its normal form.

    Raises PathError for absolute paths, paths escaping via '..',
    empty paths, NUL bytes and names that are not valid UTF-8.
    """
    if not isinstance(path, str):
        raise PathError(f"path must be str, got {type(path).__name__}")
    if not path:
        raise PathError("empty path")
    if "\x00" in path:
        raise PathError(f"NUL byte in path: {path!r}")
    try:
        path.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise PathError(f"path is not valid UTF-8: {path!r}") from exc
    if posixpath.isabs(path) or path.startswith("/"):
        raise PathError(f"absolute path not allowed: {path!r}")
    norm = posixpath.normpath(path)
    if norm in (".", ".."):
        raise PathError(f"path does not name a file: {path!r}")
    if any(part == ".." for part in norm.split("/")):
        raise PathError(f"path escapes root via '..': {path!r}")
    return norm


def _safe_join(root: str, relpath: str) -> str:
    rel = validate_relpath(relpath)
    full = os.path.join(root, *rel.split("/"))
    return full


# ---------------------------------------------------------------------------
# manifest data model


@dataclass(frozen=True)
class Block:
    index: int
    offset: int
    size: int
    adler32: int
    sha256: str

    def fingerprint(self) -> tuple:
        return (self.size, self.adler32, self.sha256)


@dataclass(frozen=True)
class FileEntry:
    path: str
    size: int
    mtime_ns: int
    blocks: tuple = ()

    def content_equal(self, other: "FileEntry") -> bool:
        if self.size != other.size or len(self.blocks) != len(other.blocks):
            return False
        return all(
            a.fingerprint() == b.fingerprint()
            for a, b in zip(self.blocks, other.blocks)
        )


@dataclass
class Manifest:
    files: dict = field(default_factory=dict)  # relpath -> FileEntry

    # -- serialization ----------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "format": MANIFEST_FORMAT,
            "version": MANIFEST_VERSION,
            "block_size": BLOCK_SIZE,
            "files": [
                {
                    "path": e.path,
                    "size": e.size,
                    "mtime_ns": e.mtime_ns,
                    "blocks": [
                        {
                            "index": b.index,
                            "offset": b.offset,
                            "size": b.size,
                            "adler32": b.adler32,
                            "sha256": b.sha256,
                        }
                        for b in e.blocks
                    ],
                }
                for e in (self.files[p] for p in sorted(self.files))
            ],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=False) + "\n"

    @classmethod
    def from_dict(cls, data: dict) -> "Manifest":
        if not isinstance(data, dict):
            raise ManifestError("manifest root must be an object")
        if data.get("format") != MANIFEST_FORMAT:
            raise ManifestError(f"bad format: {data.get('format')!r}")
        if data.get("version") != MANIFEST_VERSION:
            raise ManifestError(f"unsupported version: {data.get('version')!r}")
        if data.get("block_size") != BLOCK_SIZE:
            raise ManifestError(f"unsupported block_size: {data.get('block_size')!r}")
        raw_files = data.get("files")
        if not isinstance(raw_files, list):
            raise ManifestError("'files' must be a list")
        files = {}
        for item in raw_files:
            try:
                path = validate_relpath(item["path"])
                size = int(item["size"])
                mtime_ns = int(item["mtime_ns"])
                blocks = tuple(
                    Block(
                        index=int(b["index"]),
                        offset=int(b["offset"]),
                        size=int(b["size"]),
                        adler32=int(b["adler32"]),
                        sha256=str(b["sha256"]),
                    )
                    for b in item["blocks"]
                )
            except PathError:
                raise
            except (KeyError, TypeError, ValueError) as exc:
                raise ManifestError(f"bad file entry: {exc}") from exc
            if path in files:
                raise ManifestError(f"duplicate path in manifest: {path!r}")
            if size == 0 and blocks:
                raise ManifestError(f"empty file with blocks: {path!r}")
            files[path] = FileEntry(path=path, size=size, mtime_ns=mtime_ns,
                                    blocks=blocks)
        return cls(files=files)

    @classmethod
    def from_json(cls, text: str) -> "Manifest":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ManifestError(f"invalid JSON: {exc}") from exc
        return cls.from_dict(data)

    def save(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(self.to_json())

    @classmethod
    def load(cls, path: str) -> "Manifest":
        with open(path, "r", encoding="utf-8") as fh:
            return cls.from_json(fh.read())


# ---------------------------------------------------------------------------
# hashing / manifest building


def hash_file(fullpath: str) -> tuple:
    """Return (size, blocks) for a regular file.  Empty file -> zero blocks."""
    blocks = []
    size = 0
    with open(fullpath, "rb") as fh:
        index = 0
        while True:
            chunk = fh.read(BLOCK_SIZE)
            if not chunk:
                break
            blocks.append(Block(
                index=index,
                offset=size,
                size=len(chunk),
                adler32=zlib.adler32(chunk),
                sha256=hashlib.sha256(chunk).hexdigest(),
            ))
            size += len(chunk)
            index += 1
    return size, tuple(blocks)


def build_manifest(root: str) -> Manifest:
    """Scan *root* and build its manifest (deterministic order)."""
    if not os.path.isdir(root):
        raise PathError(f"not a directory: {root!r}")
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            dirnames[:] = [
                d for d in dirnames if not d.startswith(STAGING_PREFIX)
            ]
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = name if rel_dir == "." else os.path.join(rel_dir, name)
            rel_posix = rel.replace(os.sep, "/")
            if rel_dir == "." and name == MANIFEST_NAME:
                continue
            if rel_dir == "." and name.startswith(STAGING_PREFIX):
                continue
            st = os.lstat(full)
            if not stat.S_ISREG(st.st_mode):
                raise PathError(f"unsupported non-regular file: {rel_posix!r}")
            rel_posix = validate_relpath(rel_posix)
            size, blocks = hash_file(full)
            if size != st.st_size:
                raise ManifestError(f"file changed while scanning: {rel_posix!r}")
            files[rel_posix] = FileEntry(
                path=rel_posix, size=size, mtime_ns=st.st_mtime_ns,
                blocks=blocks,
            )
    return Manifest(files=files)


# ---------------------------------------------------------------------------
# block matching


class BlockIndex:
    """Index over all blocks of a manifest for weak->strong matching."""

    def __init__(self, manifest: Manifest):
        self._by_adler: dict = {}
        for path in sorted(manifest.files):
            for blk in manifest.files[path].blocks:
                self._by_adler.setdefault(blk.adler32, []).append((path, blk))

    def find(self, adler32: int, sha256: str):
        """Best source block for (adler32, sha256) or None.

        Candidates are filtered by weak adler32 first, then confirmed by
        strong sha256.  Ties break on lexicographically smallest path,
        then smallest block index.
        """
        best = None
        for path, blk in self._by_adler.get(adler32, ()):
            if blk.sha256 != sha256:
                continue
            key = (path, blk.index)
            if best is None or key < best:
                best = key
        return best


def find_block_match(manifest: Manifest, adler32: int, sha256: str):
    """Public helper: locate (path, block_index) matching the checksums."""
    return BlockIndex(manifest).find(adler32, sha256)


# ---------------------------------------------------------------------------
# diff


def diff(src: Manifest, dst: Manifest) -> list:
    """Ops that turn *dst* into *src*: ADD / DEL / MOD.

    MOD carries ``blocks``: the sorted list of changed block numbers.
    A target block is changed when no source block matches it (weak
    adler32, then strong sha256, anywhere in the source manifest);
    source blocks beyond the target file's length are also changed.
    """
    ops = []
    src_paths = set(src.files)
    dst_paths = set(dst.files)
    for path in sorted(src_paths - dst_paths):
        ops.append({"op": "ADD", "path": path})
    for path in sorted(dst_paths - src_paths):
        ops.append({"op": "DEL", "path": path})
    index = BlockIndex(src)
    for path in sorted(src_paths & dst_paths):
        s_entry = src.files[path]
        d_entry = dst.files[path]
        if s_entry.content_equal(d_entry):
            continue
        changed = [
            blk.index
            for blk in d_entry.blocks
            if index.find(blk.adler32, blk.sha256) is None
        ]
        changed.extend(range(len(d_entry.blocks), len(s_entry.blocks)))
        ops.append({"op": "MOD", "path": path, "blocks": sorted(changed)})
    ops.sort(key=lambda o: (o["path"], o["op"]))
    return ops


# ---------------------------------------------------------------------------
# apply


def _verify_against_manifest(manifest: Manifest, src_dir: str) -> None:
    """Ensure every manifest file exists in src_dir with matching content."""
    for path in sorted(manifest.files):
        entry = manifest.files[path]
        full = _safe_join(src_dir, path)
        if not os.path.isfile(full) or os.path.islink(full):
            raise ApplyError(f"missing source file: {path!r}")
        size, blocks = hash_file(full)
        if size != entry.size:
            raise ApplyError(f"size mismatch for {path!r}")
        got = tuple(b.fingerprint() for b in blocks)
        want = tuple(b.fingerprint() for b in entry.blocks)
        if got != want:
            raise ApplyError(f"content mismatch for {path!r}")


def apply(manifest: Manifest, src_dir: str, dst_dir: str) -> list:
    """Make *dst_dir* mirror *manifest* using data from *src_dir*.

    Everything is verified and staged in a temporary directory before
    any target file is touched; files are committed with atomic
    os.replace.  Returns the diff ops that were applied.
    """
    if not os.path.isdir(src_dir):
        raise ApplyError(f"source is not a directory: {src_dir!r}")
    os.makedirs(dst_dir, exist_ok=True)
    planned = diff(manifest, build_manifest(dst_dir))

    # Phase 1: verify all source data before touching the target.
    _verify_against_manifest(manifest, src_dir)

    # Phase 2: stage verified copies inside a temp dir in the target.
    staging = tempfile.mkdtemp(prefix=STAGING_PREFIX, dir=dst_dir)
    try:
        for path in sorted(manifest.files):
            entry = manifest.files[path]
            src_full = _safe_join(src_dir, path)
            tmp_full = os.path.join(staging, *path.split("/"))
            os.makedirs(os.path.dirname(tmp_full), exist_ok=True)
            shutil.copyfile(src_full, tmp_full)
            st = os.stat(tmp_full)
            os.utime(tmp_full, ns=(st.st_atime_ns, entry.mtime_ns))
            size, blocks = hash_file(tmp_full)
            if size != entry.size or tuple(b.fingerprint() for b in blocks) != \
                    tuple(b.fingerprint() for b in entry.blocks):
                raise ApplyError(f"staged copy mismatch for {path!r}")

        # Phase 3: commit staged files atomically.
        for path in sorted(manifest.files):
            tmp_full = os.path.join(staging, *path.split("/"))
            dst_full = _safe_join(dst_dir, path)
            os.makedirs(os.path.dirname(dst_full) or dst_dir, exist_ok=True)
            os.replace(tmp_full, dst_full)

        # Phase 4: remove files that are not in the manifest (DEL).
        current = build_manifest(dst_dir)
        for path in sorted(current.files):
            if path not in manifest.files:
                os.remove(_safe_join(dst_dir, path))
        # prune empty directories bottom-up
        for dirpath, dirnames, filenames in os.walk(dst_dir, topdown=False):
            if dirpath == dst_dir:
                continue
            if os.path.basename(dirpath).startswith(STAGING_PREFIX):
                continue
            try:
                os.rmdir(dirpath)
            except OSError:
                pass
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return planned
