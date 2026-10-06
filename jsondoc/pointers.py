"""RFC 6901 JSON Pointer helpers."""
from __future__ import annotations

__all__ = ["PointerError", "parse", "format", "escape", "unescape", "is_prefix"]


class PointerError(ValueError):
    """Raised for malformed JSON pointers."""


def unescape(segment):
    out = []
    i = 0
    while i < len(segment):
        ch = segment[i]
        if ch == "~":
            if i + 1 >= len(segment) or segment[i + 1] not in "01":
                raise PointerError("bad escape in segment: %r" % segment)
            out.append("/" if segment[i + 1] == "1" else "~")
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def escape(segment):
    return segment.replace("~", "~0").replace("/", "~1")


def parse(pointer):
    """Parse a JSON pointer string into a list of segments."""
    if pointer == "":
        return []
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        raise PointerError("invalid JSON pointer: %r" % (pointer,))
    return [unescape(part) for part in pointer.split("/")[1:]]


def format(segments):
    """Format a segment list as a JSON pointer (root is ``""``)."""
    if not segments:
        return ""
    return "/" + "/".join(escape(str(seg)) for seg in segments)


def is_prefix(root, path):
    """True when formatted path ``root`` is ``path`` or an ancestor of it."""
    return root == "" or path == root or path.startswith(root + "/")
