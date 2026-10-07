"""Gomory-Hu cut trees for undirected integer-capacity multigraphs."""

from .graph import Graph, cut_capacity
from .maxflow import Dinic, flow_ok, min_cut
from .tree import CutTree, TreeEdge, UpdateError, canonical_side

__all__ = [
    "Graph",
    "cut_capacity",
    "Dinic",
    "flow_ok",
    "min_cut",
    "CutTree",
    "TreeEdge",
    "UpdateError",
    "canonical_side",
]

__version__ = "1.0.0"
