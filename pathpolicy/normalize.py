"""Path normalization.

A canonical path is ``/`` (the empty root) or ``/seg/seg/...`` where every
segment is non-empty and is neither ``.`` nor ``..``.  Normalization folds
consecutive separators and ``.`` segments, resolves ``..`` by popping the
previous segment, and rejects any ``..`` that would escape the root.
"""


class PathError(ValueError):
    """Base error for malformed paths."""


class PathEscapeError(PathError):
    """Raised when '..' would escape above the root."""


def normalize_path(path):
    """Return the canonical form of *path*.

    Raises PathEscapeError if '..' escapes the root, PathError for
    non-string input.
    """
    if not isinstance(path, str):
        raise PathError("path must be a string, got %r" % type(path).__name__)
    segments = []
    for part in path.split("/"):
        if part == "" or part == ".":
            continue
        if part == "..":
            if not segments:
                raise PathEscapeError("path escapes root: %r" % (path,))
            segments.pop()
            continue
        segments.append(part)
    return "/" + "/".join(segments)


def path_segments(path):
    """Return the tuple of canonical segments of *path* (root -> ())."""
    norm = normalize_path(path)
    if norm == "/":
        return ()
    return tuple(norm[1:].split("/"))
