"""Exact rational planar arrangement of line segments.

Public surface:
    Arrangement  -- incremental segment set -> planar subdivision
    sweep_intersections -- exact Bentley-Ottmann sweep
    atomic_decomposition -- canonical collinear-overlap atoms
"""

from .arrangement import Arrangement
from .atomic import atomic_decomposition
from .sweep import sweep_intersections

__all__ = ["Arrangement", "atomic_decomposition", "sweep_intersections"]
