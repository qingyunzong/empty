"""Build a half-edge (DCEL) planar subdivision from atomic segments.

Steps:
  1. split every atomic segment at all intersection / point-segment
     points lying on it -> planar straight-line edges;
  2. create twin half-edges per edge;
  3. sort outgoing half-edges around every vertex by polar angle using
     an exact comparator (half-plane + cross product, never atan);
  4. connect next/prev so each face lies on the left of its boundary;
  5. walk boundary cycles, classify by exact signed area, group holes
     into their innermost containing face, attach isolated vertices.

Everything is exact rational arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cmp_to_key

from .geom import cmp_angle, on_segment, param_t


@dataclass
class Topology:
    points: list = field(default_factory=list)        # vertex points
    edges: list = field(default_factory=list)         # (u, v, sources)
    faces: list = field(default_factory=list)         # dicts, see below
    outer_face: int = 0                               # index into faces
    # face dict: {"outer": [vertex ids] | None,
    #             "holes": [[vertex ids], ...],
    #             "isolated": [vertex ids]}


def _signed_double_area(cycle, points):
    """Exact signed double area of a closed vertex-id walk."""
    total = 0
    n = len(cycle)
    for i in range(n):
        x1, y1 = points[cycle[i]]
        x2, y2 = points[cycle[(i + 1) % n]]
        total += x1 * y2 - x2 * y1
    return total



def _on_cycle_boundary(pt, cycle, points):
    """True iff pt coincides with a cycle vertex or lies on a cycle edge."""
    n = len(cycle)
    for i in range(n):
        a = points[cycle[i]]
        b = points[cycle[(i + 1) % n]]
        if pt == a or pt == b or on_segment(pt, a, b):
            return True
    return False

def _point_in_cycle(pt, cycle, points):
    """Strict point-in-polygon test (exact ray casting, +x direction).

    Precondition: pt does not lie on the cycle boundary.
    """
    px, py = pt
    inside = False
    n = len(cycle)
    for i in range(n):
        ax, ay = points[cycle[i]]
        bx, by = points[cycle[(i + 1) % n]]
        if (ay > py) != (by > py):
            x_int = ax + (py - ay) * (bx - ax) / (by - ay)
            if x_int > px:
                inside = not inside
    return inside


def build_topology(atomic_segments, split_points, point_segments):
    """Assemble the planar subdivision.

    ``atomic_segments``: list of AtomicSeg.
    ``split_points``: points where segments meet (from the sweep).
    ``point_segments``: list of (point, source_id) zero-length segments.
    """
    # ---- 1. split atoms into edges ------------------------------------
    edge_map = {}  # (pa, pb) canonical -> sources
    vertex_set = set()

    def add_edge(pa, pb, sources):
        if pa == pb:
            return
        key = (pa, pb) if pa < pb else (pb, pa)
        if key in edge_map:
            edge_map[key] |= sources
        else:
            edge_map[key] = set(sources)

    loose_points = [pt for pt, _sid in point_segments]

    for atom in atomic_segments:
        cuts = {atom.p, atom.q}
        for pt in split_points:
            if pt != atom.p and pt != atom.q and on_segment(pt, atom.p, atom.q):
                cuts.add(pt)
        for pt in loose_points:
            if pt != atom.p and pt != atom.q and on_segment(pt, atom.p, atom.q):
                cuts.add(pt)
        ordered = sorted(cuts, key=lambda pt: param_t(atom.line, pt))
        for a, b in zip(ordered, ordered[1:]):
            add_edge(a, b, atom.sources)
        vertex_set.update(ordered)

    covered = set()
    for (pa, pb) in edge_map:
        covered.add(pa)
        covered.add(pb)
    # Point segments on an edge interior became split points above; point
    # segments coinciding with existing vertices are covered as well.
    isolated = []
    for pt in loose_points:
        if pt in vertex_set:
            continue
        if any(on_segment(pt, pa, pb) for (pa, pb) in edge_map):
            vertex_set.add(pt)  # on an edge interior (already split)
            continue
        isolated.append(pt)
        vertex_set.add(pt)

    points = sorted(vertex_set)
    vid = {pt: i for i, pt in enumerate(points)}
    edges = sorted(
        (vid[a], vid[b], frozenset(src)) for (a, b), src in edge_map.items()
    )

    # ---- 2-3. half-edges and exact angular order ----------------------
    # outgoing[v] = list of (direction, edge_index, flip) half-edges
    outgoing = [[] for _ in points]
    for ei, (u, v, _src) in enumerate(edges):
        pu, pv = points[u], points[v]
        outgoing[u].append(((pv[0] - pu[0], pv[1] - pu[1]), ei, 0))
        outgoing[v].append(((pu[0] - pv[0], pu[1] - pv[1]), ei, 1))
    for lst in outgoing:
        lst.sort(key=cmp_to_key(lambda h1, h2: cmp_angle(h1[0], h2[0])))

    # Half-edge id: 2*ei + flip (flip 0: u->v, 1: v->u).
    # position[hid] = rank of half-edge hid in its origin's CCW order.
    position = {}
    for lst in outgoing:
        for rank, (_d, ei, flip) in enumerate(lst):
            position[2 * ei + flip] = rank

    def he_origin(hid):
        u, v, _ = edges[hid // 2]
        return v if hid % 2 else u

    def he_target(hid):
        u, v, _ = edges[hid // 2]
        return u if hid % 2 else v

    def he_next(hid):
        """Next half-edge around the face on the left of ``hid``."""
        twin = hid ^ 1
        origin = he_origin(twin)
        lst = outgoing[origin]
        rank = position[twin]
        # Predecessor of the twin in CCW order = face turns "right-most".
        _d, ei, flip = lst[(rank - 1) % len(lst)]
        return 2 * ei + flip

    # ---- 4. walk boundary cycles --------------------------------------
    face_of = {}
    cycles = []  # list of (cycle vertex ids, signed double area)
    for start in range(2 * len(edges)):
        if start in face_of:
            continue
        walk = []
        hid = start
        while hid not in face_of:
            face_of[hid] = len(cycles)
            walk.append(he_origin(hid))
            hid = he_next(hid)
        cycles.append((walk, _signed_double_area(walk, points)))

    # ---- 5. classify cycles and group holes ---------------------------
    positives = [i for i, (_w, area) in enumerate(cycles) if area > 0]
    negatives = [i for i, (_w, area) in enumerate(cycles) if area < 0]
    # Zero-area walks arise from tree-like components (their boundary
    # walks out and back along the same edges); they belong to the
    # unbounded face.
    zeros = [i for i, (_w, area) in enumerate(cycles) if area == 0]

    faces = []
    cycle_face = {}
    for ci in positives:
        cycle_face[ci] = len(faces)
        faces.append({"outer": cycles[ci][0], "holes": [], "isolated": []})
    outer_idx = len(faces)
    faces.append({"outer": None, "holes": [], "isolated": []})

    for ci in zeros:
        faces[outer_idx]["holes"].append(cycles[ci][0])
        cycle_face[ci] = outer_idx

    for ci in negatives:
        walk, _area = cycles[ci]
        probe = points[walk[0]]
        best = None
        best_area = None
        for pi in positives:
            # A boundary component that touches the positive cycle is
            # connected to it and cannot be a strictly nested hole.
            if _on_cycle_boundary(probe, cycles[pi][0], points):
                continue
            if _point_in_cycle(probe, cycles[pi][0], points):
                area = cycles[pi][1]
                if best_area is None or area < best_area:
                    best, best_area = pi, area
        target = cycle_face[best] if best is not None else outer_idx
        faces[target]["holes"].append(walk)
        cycle_face[ci] = target

    # Isolated vertices belong to their innermost containing face.
    for pt in isolated:
        vi = vid[pt]
        best = None
        best_area = None
        for pi in positives:
            if _point_in_cycle(pt, cycles[pi][0], points):
                area = cycles[pi][1]
                if best_area is None or area < best_area:
                    best, best_area = pi, area
        target = cycle_face[best] if best is not None else outer_idx
        faces[target]["isolated"].append(vi)

    return Topology(
        points=points, edges=edges, faces=faces, outer_face=outer_idx
    )
