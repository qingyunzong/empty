"""Patch application with atomic fingerprint validation.

All source fingerprints are validated *before* any mutation; on any
failure the target tree is left completely unchanged (application works on
a copy and only returns a new tree on success).  After executing the plan
steps, the destination fingerprints are verified as a postcondition.
"""
from __future__ import annotations

from .model import FileTree, parent_paths, validate_path


class ApplyError(RuntimeError):
    """Raised when a patch cannot be applied; the target tree is unchanged."""


def apply_patch(tree, patch):
    """Apply *patch* to *tree*, returning the resulting new :class:`FileTree`.

    Raises :class:`ApplyError` on any validation failure; *tree* is never
    mutated.
    """
    if not isinstance(patch, dict) or patch.get("version") != 1:
        raise ApplyError("unsupported patch")
    expected = patch.get("src_fingerprints")
    if not isinstance(expected, dict) or tree.file_fingerprints() != expected:
        raise ApplyError("source fingerprint mismatch; patch not applied")

    files = {p: list(ls) for p, ls in tree.files.items()}
    dirs = set(tree.all_dirs)

    for step in patch.get("plan", []):
        kind = step.get("step")
        if kind == "delete":
            p = step["path"]
            if p not in files:
                raise ApplyError(f"delete: no such file {p!r}")
            del files[p]
        elif kind == "rename":
            s, d = step["src"], step["dst"]
            validate_path(d)
            if s not in files:
                raise ApplyError(f"rename: no such file {s!r}")
            if d in files or d in dirs:
                raise ApplyError(f"rename: destination {d!r} is occupied")
            for anc in parent_paths(d):
                if anc not in dirs:
                    raise ApplyError(f"rename: missing parent {anc!r}")
            files[d] = files.pop(s)
        elif kind == "modify":
            p = step["path"]
            if p not in files:
                raise ApplyError(f"modify: no such file {p!r}")
            files[p] = list(step["lines"])
        elif kind == "add":
            p = step["path"]
            validate_path(p)
            if p in files or p in dirs:
                raise ApplyError(f"add: {p!r} already exists")
            for anc in parent_paths(p):
                if anc not in dirs:
                    raise ApplyError(f"add: missing parent {anc!r}")
            files[p] = list(step["lines"])
        elif kind == "mkdir":
            p = step["path"]
            validate_path(p)
            if p in dirs or p in files:
                raise ApplyError(f"mkdir: {p!r} already exists")
            for anc in parent_paths(p):
                if anc not in dirs:
                    raise ApplyError(f"mkdir: missing parent {anc!r}")
            dirs.add(p)
        elif kind == "rmdir":
            p = step["path"]
            if p not in dirs:
                raise ApplyError(f"rmdir: no such directory {p!r}")
            pre = p + "/"
            if any(f.startswith(pre) for f in files) or \
                    any(d != p and d.startswith(pre) for d in dirs):
                raise ApplyError(f"rmdir: directory {p!r} is not empty")
            dirs.discard(p)
        else:
            raise ApplyError(f"unknown plan step: {kind!r}")

    result = FileTree(files, dirs)
    if result.file_fingerprints() != patch.get("dst_fingerprints"):
        raise ApplyError("destination fingerprint mismatch after applying plan")
    return result
