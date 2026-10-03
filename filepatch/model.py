"""File-tree model and fingerprints.

A tree is a set of files.  Each file has a normalized path, the type
``"file"`` and a sequence of content lines.  Directories are implicit;
a path may therefore never be a proper prefix of another path in the
same tree (that would be a file/directory conflict).
"""
from __future__ import annotations

import hashlib
import json


class TreeError(ValueError):
    """Raised when a tree descriptor is invalid."""


def normalize_path(path):
    """Validate and normalize a relative file path."""
    if not isinstance(path, str) or not path:
        raise TreeError("path must be a non-empty string")
    if path.startswith("/"):
        raise TreeError("absolute paths are not allowed: %r" % path)
    parts = path.split("/")
    for part in parts:
        if part in ("", ".", ".."):
            raise TreeError("invalid path segment in %r" % path)
    return "/".join(parts)


def content_sha256(lines):
    """Fingerprint of a single file's content (its line sequence)."""
    return hashlib.sha256(
        json.dumps(list(lines), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


class Tree:
    """An immutable-ish file tree: mapping of path -> list of lines."""

    def __init__(self, files=None):
        self.files = {}
        for path, lines in (files or {}).items():
            norm = normalize_path(path)
            if norm in self.files:
                raise TreeError("duplicate path: %r" % path)
            self.files[norm] = list(lines)
        self._check_prefix_conflicts()

    def _check_prefix_conflicts(self):
        paths = sorted(self.files)
        for i, path in enumerate(paths):
            for other in paths[i + 1:]:
                if other.startswith(path + "/"):
                    raise TreeError(
                        "path %r is a file and a directory (see %r)" % (path, other)
                    )
                if not other.startswith(path[:1]):
                    break

    @classmethod
    def from_descriptor(cls, desc):
        """Build a tree from ``{"files": [{"path", "type", "lines"}, ...]}``."""
        if not isinstance(desc, dict) or "files" not in desc:
            raise TreeError("tree descriptor must be an object with a 'files' list")
        files = {}
        for entry in desc["files"]:
            if entry.get("type", "file") != "file":
                raise TreeError("unsupported entry type: %r" % entry.get("type"))
            path = normalize_path(entry["path"])
            if path in files:
                raise TreeError("duplicate path: %r" % path)
            lines = entry.get("lines", [])
            if not isinstance(lines, list) or not all(
                isinstance(line, str) and "\n" not in line for line in lines
            ):
                raise TreeError("lines must be a list of strings without newlines")
            files[path] = list(lines)
        return cls(files)

    def to_descriptor(self):
        return {
            "files": [
                {"path": path, "type": "file", "lines": list(self.files[path])}
                for path in sorted(self.files)
            ]
        }

    def fingerprint(self):
        """Fingerprint of the whole tree (paths + contents)."""
        digest = hashlib.sha256()
        for path in sorted(self.files):
            digest.update(path.encode("utf-8"))
            digest.update(b"\0")
            digest.update(content_sha256(self.files[path]).encode("ascii"))
            digest.update(b"\n")
        return digest.hexdigest()

    def __eq__(self, other):
        return isinstance(other, Tree) and self.files == other.files

    def __repr__(self):
        return "Tree(%r)" % (self.files,)
