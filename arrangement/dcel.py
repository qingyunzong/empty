"""Doubly-connected edge list with exact angular stitching.

Half-edges around every vertex are ordered by an exact polar-angle
predicate (half-plane test + cross product sign); no floating point
``atan`` is ever used.  Face boundaries are extracted by walking
``next`` pointers; the unbounded (outer) faces are the cycles with
negative signed area.
"""

from __future__ import annotations

from collections import defaultdict
from fractions import Fraction
from functools import cmp_to_key

from .geometry import angle_cmp, cross_vec


class Vertex:
    __slots__ = ("id", "point")

    def __init__(self, vid, point):
        self.id = vid
        self.point = point


class Edge:
    """An undirected atomic edge with the set of source segment ids."""

    __slots__ = ("id", "v0", "v1", "sources")

    def __init__(self, eid, v0, v1, sources):
        self.id = eid
        self.v0 = v0
        self.v1 = v1
        self.sources = frozenset(sources)


class HalfEdge:
    __slots__ = ("id", "origin", "target", "edge", "twin", "next", "prev", "face")

    def __init__(self, hid, origin, target, edge):
        self.id = hid
        self.origin = origin
        self.target = target
        self.edge = edge
        self.twin = None
        self.next = None
        self.prev = None
        self.face = None


class Face:
    __slots__ = ("id", "halfedges", "area", "is_outer")

    def __init__(self, fid, halfedges, area):
        self.id = fid
        self.halfedges = halfedges
        self.area = area
        self.is_outer = area < 0


class Topology:
    """Container for the full half-edge structure."""

    def __init__(self, vertices, edges, halfedges, faces, components,
                 components_with_edges):
        self.vertices = vertices          # list[Vertex]
        self.edges = edges                # list[Edge]
        self.halfedges = halfedges        # list[HalfEdge]
        self.faces = faces                # list[Face]
        self.components = components
        self.components_with_edges = components_with_edges
        self.vertex_by_id = {v.id: v for v in vertices}
        self.edge_by_id = {e.id: e for e in edges}
        self.halfedge_by_id = {h.id: h for h in halfedges}

    def euler_value(self):
        """V - E + F, which must equal C + C_e for a valid embedding."""
        return len(self.vertices) - len(self.edges) + len(self.faces)


def build_dcel(vertex_ids, edge_specs):
    """Build the half-edge structure.

    ``vertex_ids``: dict point -> vertex id.
    ``edge_specs``: iterable of ``(eid, p0, p1, sources)``.
    """
    vertices = [Vertex(vid, pt) for pt, vid in sorted(vertex_ids.items(),
                                                      key=lambda kv: kv[1])]
    point_of = {v.id: v.point for v in vertices}

    edges = []
    halfedges = []
    outgoing = defaultdict(list)
    for eid, p0, p1, sources in sorted(edge_specs, key=lambda s: s[0]):
        v0, v1 = vertex_ids[p0], vertex_ids[p1]
        edge = Edge(eid, v0, v1, sources)
        edges.append(edge)
        h0 = HalfEdge(2 * eid, v0, v1, eid)
        h1 = HalfEdge(2 * eid + 1, v1, v0, eid)
        h0.twin = h1
        h1.twin = h0
        halfedges.extend((h0, h1))
        outgoing[v0].append(h0)
        outgoing[v1].append(h1)

    # exact angular order of outgoing half-edges at every vertex
    order_index = {}
    for vid, lst in outgoing.items():
        def cmp(h1, h2):
            p = point_of[vid]
            d1 = (point_of[h1.target][0] - p[0], point_of[h1.target][1] - p[1])
            d2 = (point_of[h2.target][0] - p[0], point_of[h2.target][1] - p[1])
            return angle_cmp(d1, d2)
        lst.sort(key=cmp_to_key(cmp))
        for i, h in enumerate(lst):
            order_index[h.id] = i

    # stitch next/prev: next(h) is the half-edge just clockwise from twin(h)
    for h in halfedges:
        twin = h.twin
        lst = outgoing[twin.origin]
        nxt = lst[(order_index[twin.id] - 1) % len(lst)]
        h.next = nxt
        nxt.prev = h

    # face traversal
    faces = []
    visited = set()
    for h in halfedges:
        if h.id in visited:
            continue
        cycle = []
        cur = h
        while cur.id not in visited:
            visited.add(cur.id)
            cycle.append(cur)
            cur = cur.next
        twice_area = sum(
            cross_vec(point_of[c.origin], point_of[c.target]) for c in cycle
        )
        face = Face(len(faces), cycle, Fraction(twice_area, 2))
        faces.append(face)
        for c in cycle:
            c.face = face.id

    # connected components (isolated vertices included)
    parent = {v.id: v.id for v in vertices}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for e in edges:
        union(e.v0, e.v1)
    roots = {find(v.id) for v in vertices}
    edge_roots = {find(e.v0) for e in edges}

    return Topology(vertices, edges, halfedges, faces, len(roots),
                    len(edge_roots))
