"""Validated, atomic application of operation lists to a tree."""
from __future__ import annotations

from .model import Tree, content_sha256


class ApplyError(RuntimeError):
    """Raised when a patch cannot be applied; the tree is left unchanged."""


def _check_ancestors_free(files, path):
    parts = path.split("/")
    for k in range(1, len(parts)):
        ancestor = "/".join(parts[:k])
        if ancestor in files:
            raise ApplyError(
                "cannot create %r: %r is a file (file/directory conflict)"
                % (path, ancestor)
            )


def _check_fingerprint(files, path, expected):
    if expected is not None and content_sha256(files[path]) != expected:
        raise ApplyError("source fingerprint mismatch at %r" % path)


def apply_ops(files, ops):
    """Apply ``ops`` to a ``{path: lines}`` mapping; return a new mapping.

    Every operation is validated (existence, fingerprints, file/dir
    conflicts).  The input mapping is never mutated: work happens on a
    copy, so any failure leaves the original tree untouched.
    """
    files = {path: list(lines) for path, lines in files.items()}
    for index, op in enumerate(ops):
        kind = op.get("op")
        try:
            if kind == "delete":
                path = op["path"]
                if path not in files:
                    raise ApplyError("delete of missing path %r" % path)
                _check_fingerprint(files, path, op.get("src_sha256"))
                del files[path]
            elif kind == "create":
                path = op["path"]
                if path in files:
                    raise ApplyError("create of existing path %r" % path)
                _check_ancestors_free(files, path)
                files[path] = list(op["lines"])
            elif kind == "rename":
                src, dst = op["src"], op["dst"]
                if src not in files:
                    raise ApplyError("rename of missing path %r" % src)
                if dst in files:
                    raise ApplyError("rename target %r already exists" % dst)
                _check_ancestors_free(files, dst)
                _check_fingerprint(files, src, op.get("src_sha256"))
                files[dst] = files.pop(src)
            elif kind == "modify":
                path = op["path"]
                if path not in files:
                    raise ApplyError("modify of missing path %r" % path)
                _check_fingerprint(files, path, op.get("src_sha256"))
                files[path] = list(op["lines"])
            else:
                raise ApplyError("unknown operation %r" % kind)
        except (KeyError, TypeError) as exc:
            raise ApplyError("malformed operation #%d: %r" % (index, op)) from exc
    return files


def apply_ops_to_tree(tree, ops):
    return Tree(apply_ops(tree.files, ops))
