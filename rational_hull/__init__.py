"""Exact rational 2D dynamic convex hull with versioned snapshots."""

from .checker import (
    VerificationError,
    brute_force_hull,
    canonical_vertices,
    verify,
    verify_hull,
)
from .core import (
    DynamicConvexHull,
    Edge,
    HullResult,
    HullStats,
    Version,
    as_fraction,
)
from .geometry import Point, dist2, edge_coefficients, orient, orient_sign

__all__ = [
    "DynamicConvexHull",
    "Edge",
    "HullResult",
    "HullStats",
    "Point",
    "Version",
    "VerificationError",
    "as_fraction",
    "brute_force_hull",
    "canonical_vertices",
    "dist2",
    "edge_coefficients",
    "orient",
    "orient_sign",
    "verify",
    "verify_hull",
]

__version__ = "1.0.0"
