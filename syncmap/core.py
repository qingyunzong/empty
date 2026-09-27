"""Core logic for syncmap: manifests, block matching and diffing.

Files are split into 64 KiB blocks.  Each block carries a weak adler32
checksum and a strong sha256 checksum.  A manifest describes a directory
tree as a mapping of POSIX relative UTF-8 paths to file metadata plus the
per-block checksum table.
"""

from __future__ import annotations

import hashlib
import json
import os
import zlib
from dataclasses import dataclass, field
from pathlib import Path

BLOCK_SIZE = 64 * 1024
MANIFEST_NAME = ".manifest"
MANIFEST_VERSION = 1


class PathError(ValueError):
    """Raised when a path is not a valid POSIX relative UTF-8 path."""


def validate_relpath(path: str) -> str:
    """Validate a POSIX relative UTF-8 path.

    Rejects absolute paths, empty segments, ``.``/``..`` segments (no
    escaping the tree), NUL bytes and strings that are not encodable as
    UTF-8.  Returns the path unchanged on success.
    """
    if not isinstance(path, str) or not path:
        raise PathError(f"empty or non-string path: {path!r}")
    try:
        path.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise PathError(f"path is not valid UTF-8: {path!r}") from exc
    if "\x00" in path:
        raise PathError(f"path contains NUL byte: {path!r}")
    if path.startswith("/"):
        raise PathError(f"absolute path not allowed: {path!r}")
    for segment in path.split("/"):
        if segment in ("", "."):
            raise PathError(f"empty or '.' segment in path: {path!r}")
        if segment == "..":
            raise PathError(f"'..' segment escapes the tree: {path!r}")
    return path


@dataclass(frozen=True)
class Block:
    adler32: int
    sha256: str


@dataclass(frozen=True)
class FileEntry:
    path: str
    size: int
    mtime_ns: int
    blocks: tuple  # tuple[Block, ...]; empty for empty files


@dataclass
class Manifest:
    files: dict  # path -> FileEntry

    def to_dict(self) -> dict:
        return {
            "version": MANIFEST_VERSION,
            "block_size": BLOCK_SIZE,
            "files": {
                path: {
                    "size": entry.size,
                    "mtime_ns": entry.mtime_ns,
                    "blocks": [
                        {"adler32": blk.adler32, "sha256": blk.sha256}
                        for blk in entry.blocks
                    ],
                }
                for path, entry in sorted(self.files.items())
            },
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Manifest":
        if data.get("version") != MANIFEST_VERSION:
            raise ValueError(f"unsupported manifest version: {data.get('version')!r}")
        if data.get("block_size") != BLOCK_SIZE:
            raise ValueError(f"unsupported block size: {data.get('block_size')!r}")
        files = {}
        for path, entry in data.get("files", {}).items():
            validate_relpath(path)
            blocks = tuple(
                Block(adler32=int(b["adler32"]), sha256=str(b["sha256"]))
                for b in entry["blocks"]
            )
            files[path] = FileEntry(
                path=path,
                size=int(entry["size"]),
                mtime_ns=int(entry["mtime_ns"]),
                blocks=blocks,
            )
        return cls(files=files)


def hash_block(data: bytes) -> Block:
    return Block(adler32=zlib.adler32(data), sha256=hashlib.sha256(data).hexdigest())


def scan_file(full_path: Path, rel_path: str) -> FileEntry:
    stat = os.stat(full_path)
    blocks = []
    with open(full_path, "rb") as fh:
        while True:
            chunk = fh.read(BLOCK_SIZE)
            if not chunk:
                break
            blocks.append(hash_block(chunk))
    return FileEntry(
        path=rel_path,
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
        blocks=tuple(blocks),
    )


def build_manifest(root) -> Manifest:
    """Scan a directory tree and build its manifest.

    The top-level ``.manifest`` file is excluded from the scan.
    """
    root = Path(root)
    if not root.is_dir():
        raise NotADirectoryError(str(root))
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, root)
        for name in sorted(filenames):
            if rel_dir == "." and name == MANIFEST_NAME:
                continue
            full = Path(dirpath) / name
            if not full.is_file() or full.is_symlink():
                continue
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            rel = rel.replace(os.sep, "/")
            validate_relpath(rel)
            files[rel] = scan_file(full, rel)
    return Manifest(files=files)


def write_manifest(manifest: Manifest, path) -> None:
    text = json.dumps(manifest.to_dict(), indent=2, sort_keys=False)
    Path(path).write_text(text + "\n", encoding="utf-8")


def load_manifest(path) -> Manifest:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return Manifest.from_dict(data)


class SourceIndex:
    """Index over all blocks of a source manifest.

    Matching semantics: a target block first filters source blocks by
    adler32, then by sha256.  If several source blocks share the same
    strong checksum, the one with the lexicographically smallest path
    wins; ties on path are broken by the smallest block number.
    """

    def __init__(self, manifest: Manifest):
        self._by_adler = {}
        for path, entry in manifest.files.items():
            for idx, blk in enumerate(entry.blocks):
                self._by_adler.setdefault(blk.adler32, []).append(
                    (blk.sha256, path, idx)
                )

    def match(self, block: Block):
        """Return (path, block_index) of the chosen source block, or None."""
        candidates = self._by_adler.get(block.adler32)
        if not candidates:
            return None
        strong = [
            (path, idx)
            for sha, path, idx in candidates
            if sha == block.sha256
        ]
        if not strong:
            return None
        return min(strong)


@dataclass
class Op:
    kind: str  # "ADD" | "DEL" | "MOD"
    path: str
    changed_blocks: tuple = ()  # target block numbers with no strong source match
    matched: dict = field(default_factory=dict)  # target blk -> (src path, src blk)

    def format(self) -> str:
        if self.kind == "MOD":
            blocks = ",".join(str(i) for i in self.changed_blocks) or "-"
            return f"MOD {self.path} {blocks}"
        return f"{self.kind} {self.path}"


def diff(src: Manifest, tgt: Manifest) -> list:
    """Compute ops that transform the target tree into the source tree."""
    ops = []
    index = SourceIndex(src)
    for path in sorted(set(src.files) | set(tgt.files)):
        in_src = path in src.files
        in_tgt = path in tgt.files
        if in_src and not in_tgt:
            ops.append(Op("ADD", path))
        elif in_tgt and not in_src:
            ops.append(Op("DEL", path))
        else:
            s_entry = src.files[path]
            t_entry = tgt.files[path]
            if s_entry.size == t_entry.size and s_entry.blocks == t_entry.blocks:
                continue
            changed = []
            matched = {}
            for idx, blk in enumerate(t_entry.blocks):
                hit = index.match(blk)
                if hit is None:
                    changed.append(idx)
                else:
                    matched[idx] = hit
            ops.append(
                Op("MOD", path, changed_blocks=tuple(changed), matched=matched)
            )
    return ops
