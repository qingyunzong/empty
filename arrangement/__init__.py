"""Exact planar arrangement of rational-coordinate line segments.

Public API:

* :class:`Arrangement` -- incremental segment set + derived topology.
* :func:`verify_all` -- independent topology verification.
* :func:`to_json` / :func:`from_json` -- save & restore.
"""

from .arrangement import Arrangement
from .errors import ArrangementError
from .serialize import arrangement_from_dict, arrangement_to_dict
from .verify import verify_all

__all__ = [
    "Arrangement",
    "ArrangementError",
    "verify_all",
    "to_json",
    "from_json",
]

__version__ = "1.0.0"


def to_json(arrangement):
    """Serialize an Arrangement to a JSON-compatible dict."""
    return arrangement_to_dict(arrangement)


def from_json(data):
    """Restore an Arrangement from :func:`to_json` output."""
    return arrangement_from_dict(data)
