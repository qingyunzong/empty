"""Enumerate canonical paths over a small set of directory names."""
from itertools import product


def enumerate_paths(names, max_depth):
    """Yield every canonical path whose segments come from *names*.

    Includes the empty root "/" and all sequences up to *max_depth*
    segments.  Names must be valid segments (non-empty, no separator,
    not "." or "..").
    """
    names = list(names)
    for name in names:
        if not name or "/" in name or name in (".", ".."):
            raise ValueError("invalid segment name: %r" % (name,))
    yield "/"
    for depth in range(1, max_depth + 1):
        for combo in product(names, repeat=depth):
            yield "/" + "/".join(combo)
