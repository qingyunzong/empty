"""Path normalization.

Paths are relative to a virtual root.  Normalization collapses consecutive
separators, resolves ``.`` and ``..`` segments, and rejects paths that would
escape the root.  The root itself is the empty string ``""``.
"""


class PathError(ValueError):
    """Raised for malformed paths and paths escaping the root."""


def normalize_path(path):
    if not isinstance(path, str):
        raise PathError("path must be a string")
    segments = []
    for part in path.split("/"):
        if part == "" or part == ".":
            continue
        if part == "..":
            if not segments:
                raise PathError("path escapes the root: %r" % path)
            segments.pop()
        else:
            segments.append(part)
    return "/".join(segments)


def path_segments(normalized):
    return [] if normalized == "" else normalized.split("/")
