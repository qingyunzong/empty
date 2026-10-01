"""JSON Pointer style paths and index patterns.

Concrete paths are tuples whose segments are ``str`` for object keys and
``int`` for array positions.  Patterns additionally allow the wildcard
segment ``*`` which matches any single key or index.  A numeric pattern
segment such as ``"0"`` matches both the array index ``0`` and the object
key ``"0"``; an object key that is literally ``*`` can only be reached
through the wildcard.
"""

from .errors import QueryError

WILDCARD = "*"


def _unescape(seg):
    return seg.replace("~1", "/").replace("~0", "~")


def _escape(seg):
    return seg.replace("~", "~0").replace("/", "~1")


def parse_pointer(text):
    """Parse a JSON Pointer into a tuple of raw string segments."""
    if text == "":
        return ()
    if not isinstance(text, str) or not text.startswith("/"):
        raise QueryError(f"invalid JSON pointer: {text!r}")
    return tuple(_unescape(seg) for seg in text.split("/")[1:])


def to_pointer(path):
    """Render a typed concrete path back to a JSON Pointer string."""
    return "".join("/" + _escape(str(seg)) for seg in path)


def parse_pattern(text):
    """Parse an index pattern; ``*`` segments become wildcards."""
    return parse_pointer(text)


def segment_matches(pattern_seg, path_seg):
    if pattern_seg == WILDCARD:
        return True
    if isinstance(path_seg, int):
        return pattern_seg == str(path_seg)
    return pattern_seg == path_seg


def pattern_matches(pattern, path):
    if len(pattern) != len(path):
        return False
    return all(segment_matches(p, s) for p, s in zip(pattern, path))
