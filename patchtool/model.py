"""File-tree model: parsing, validation, canonicalisation, fingerprints.

A file tree is described as a JSON object::

    {"entries": [{"path": "a", "type": "dir"},
                 {"path": "a/f.txt", "type": "file", "lines": ["x", "y"]}]}

Paths are relative POSIX-style paths.  Parent directories of files are
implicit; explicit ``dir`` entries may additionally declare (possibly empty)
directories.  All fingerprints are SHA-256 over the canonical byte content
(each line followed by ``\\n``).
"""
from __future__ import annotations

import hashlib
import json


class ModelError(ValueError):
    """Raised when a tree description is malformed."""


def validate_path(path):
    if not isinstance(path, str) or not path:
        raise ModelError(f"invalid path: {path!r}")
    if path.startswith("/") or path.endswith("/") or "//" in path:
        raise ModelError(f"invalid path: {path!r}")
    for seg in path.split("/"):
        if seg in ("", ".", ".."):
            raise ModelError(f"invalid path segment in {path!r}")


def parent_paths(path):
    """All proper ancestor directories of *path*, shallowest first."""
    parts = path.split("/")
    return ["/".join(parts[:i]) for i in range(1, len(parts))]


def content_bytes(lines):
    return b"".join((line + "\n").encode("utf-8") for line in lines)


def byte_count(lines):
    """Byte size of a file's canonical content (used for add/delete cost)."""
    return sum(len(line.encode("utf-8")) + 1 for line in lines)


def fingerprint(lines):
    return hashlib.sha256(content_bytes(lines)).hexdigest()


class FileTree:
    """An immutable snapshot of a file tree.

    ``files`` maps path -> tuple of content lines; ``dirs`` is a set of
    explicitly declared directories.
    """

    def __init__(self, files, dirs=()):
        self.files = {p: tuple(ls) for p, ls in files.items()}
        self.dirs = frozenset(dirs)
        self._validate()

    def _validate(self):
        for p in list(self.files) + list(self.dirs):
            validate_path(p)
        for p in self.files:
            if p in self.dirs:
                raise ModelError(f"path is both file and dir: {p}")
        for p in list(self.files) + list(self.dirs):
            for anc in parent_paths(p):
                if anc in self.files:
                    raise ModelError(f"path {p!r} sits below file {anc!r}")

    @property
    def all_dirs(self):
        """Explicit directories plus all implicit parents of files."""
        out = set(self.dirs)
        for p in list(self.files) + list(self.dirs):
            out.update(parent_paths(p))
        return frozenset(out)

    def file_fingerprints(self):
        return {p: fingerprint(ls) for p, ls in sorted(self.files.items())}

    def to_dict(self):
        entries = [{"path": p, "type": "dir"} for p in sorted(self.all_dirs)]
        for p in sorted(self.files):
            entries.append({"path": p, "type": "file",
                            "lines": list(self.files[p])})
        entries.sort(key=lambda e: e["path"])
        return {"entries": entries}

    @staticmethod
    def from_dict(obj):
        if not isinstance(obj, dict) or "entries" not in obj:
            raise ModelError("tree must be an object with an 'entries' list")
        files = {}
        dirs = set()
        for e in obj["entries"]:
            if not isinstance(e, dict):
                raise ModelError("entry must be an object")
            path = e.get("path")
            validate_path(path)
            etype = e.get("type")
            if etype == "file":
                lines = e.get("lines", [])
                if not isinstance(lines, list) or \
                        not all(isinstance(l, str) for l in lines):
                    raise ModelError(f"lines must be a list of strings: {path}")
                if path in files:
                    raise ModelError(f"duplicate path: {path}")
                files[path] = tuple(lines)
            elif etype == "dir":
                dirs.add(path)
            else:
                raise ModelError(f"unknown entry type: {etype!r}")
        return FileTree(files, dirs)

    def tree_hash(self):
        blob = json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def __eq__(self, other):
        return (isinstance(other, FileTree)
                and self.files == other.files
                and self.all_dirs == other.all_dirs)

    def __hash__(self):
        return hash(self.tree_hash())

    def __repr__(self):
        return f"FileTree(files={self.files!r}, dirs={sorted(self.dirs)!r})"
