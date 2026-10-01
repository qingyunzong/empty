"""Incremental planar arrangement of rational-coordinate segments.

The Arrangement owns the source segment set and maintains the derived
topology (vertices, atomic edges, half-edges, faces).  Updates are
transactional: new input is fully validated and the new topology is
built before any state is committed, so a failing update leaves the
previous topology untouched.  Vertex and edge ids are content-keyed
and persist across updates, so geometry that does not change keeps its
ids; each update reports the affected (added / removed / re-sourced)
edges.
"""

from __future__ import annotations

from .dcel import build_dcel
from .errors import ArrangementError
from .geometry import make_point, on_segment
from .sweep import atomic_decomposition, split_atoms, sweep_intersections


def _validate_segment(seg):
    """Return (p, q) exact points or raise ArrangementError."""
    try:
        a_raw, b_raw = seg
        p = make_point(a_raw)
        q = make_point(b_raw)
    except (TypeError, ValueError) as exc:
        raise ArrangementError(f"invalid segment {seg!r}: {exc}") from exc
    return p, q


class Arrangement:
    def __init__(self, segments=()):
        self._segments = {}       # sid -> (p, q)
        self._next_sid = 1
        self._vid_of = {}         # point -> vertex id
        self._eid_of = {}         # (p, q) canonical -> edge id
        self._next_vid = 0
        self._next_eid = 0
        self._prev_edge_sig = {}  # eid -> (p, q, sources)
        self.topology = None
        self.intersections = set()
        self.last_affected = {"added": [], "removed": [], "resourced": []}
        if segments:
            self.insert(segments)
        else:
            self._rebuild()

    # ------------------------------------------------------------------ #
    # construction helpers
    # ------------------------------------------------------------------ #
    @classmethod
    def from_segments(cls, segments):
        return cls(segments)

    def _vid(self, pt):
        vid = self._vid_of.get(pt)
        if vid is None:
            vid = self._next_vid
            self._vid_of[pt] = vid
            self._next_vid += 1
        return vid

    def _eid(self, key):
        eid = self._eid_of.get(key)
        if eid is None:
            eid = self._next_eid
            self._eid_of[key] = eid
            self._next_eid += 1
        return eid

    def _rebuild(self):
        """Recompute derived topology; atomic on success."""
        items = [(sid, p, q) for sid, (p, q) in sorted(self._segments.items())]
        normal = [(p, q, sid) for sid, p, q in items if p != q]
        point_segs = sorted({p for sid, p, q in items if p == q})

        atoms, _ = atomic_decomposition(normal)
        splits, intersections = sweep_intersections(atoms, point_segs)
        pieces = split_atoms(atoms, splits)

        # assign stable ids (new maps are built locally first)
        new_vid_of = dict(self._vid_of)
        new_eid_of = dict(self._eid_of)
        next_vid = self._next_vid
        next_eid = self._next_eid

        def vid(pt):
            nonlocal next_vid
            v = new_vid_of.get(pt)
            if v is None:
                v = next_vid
                new_vid_of[pt] = v
                next_vid += 1
            return v

        def eid(key):
            nonlocal next_eid
            e = new_eid_of.get(key)
            if e is None:
                e = next_eid
                new_eid_of[key] = e
                next_eid += 1
            return e

        vertex_ids = {}
        for pt in point_segs:
            vertex_ids[pt] = vid(pt)
        edge_specs = []
        edge_sig = {}
        for p, q, sources in pieces:
            key = (p, q) if p < q else (q, p)
            e = eid(key)
            vertex_ids.setdefault(p, vid(p))
            vertex_ids.setdefault(q, vid(q))
            edge_specs.append((e, key[0], key[1], sources))
            edge_sig[e] = (key[0], key[1], frozenset(sources))

        topology = build_dcel(vertex_ids, edge_specs)

        # diff against previous state for the affected-region report
        prev = self._prev_edge_sig
        added = sorted(e for e in edge_sig if e not in prev)
        removed = sorted(e for e in prev if e not in edge_sig)
        resourced = sorted(
            e for e in edge_sig
            if e in prev and prev[e][2] != edge_sig[e][2]
        )

        # commit
        self._vid_of = new_vid_of
        self._eid_of = new_eid_of
        self._next_vid = next_vid
        self._next_eid = next_eid
        self._prev_edge_sig = edge_sig
        self.topology = topology
        self.intersections = intersections
        self.last_affected = {"added": added, "removed": removed,
                              "resourced": resourced}

    # ------------------------------------------------------------------ #
    # incremental updates (transactional)
    # ------------------------------------------------------------------ #
    def insert(self, segments):
        """Insert segments; returns their new source ids.

        On invalid input raises ArrangementError and leaves the current
        topology untouched.
        """
        parsed = [_validate_segment(s) for s in segments]
        if not parsed:
            return []
        sids = []
        for p, q in parsed:
            sid = self._next_sid
            self._next_sid += 1
            self._segments[sid] = (p, q)
            sids.append(sid)
        try:
            self._rebuild()
        except Exception:
            for sid in sids:
                del self._segments[sid]
            self._next_sid = sids[0]
            self._rebuild()
            raise
        return sids

    def delete(self, sids):
        """Delete source segments by id; unknown ids raise and change nothing."""
        missing = [s for s in sids if s not in self._segments]
        if missing:
            raise ArrangementError(f"unknown segment ids: {missing}")
        removed = {s: self._segments.pop(s) for s in sids}
        try:
            self._rebuild()
        except Exception:
            self._segments.update(removed)
            self._rebuild()
            raise
        return sorted(removed)

    # ------------------------------------------------------------------ #
    # accessors
    # ------------------------------------------------------------------ #
    @property
    def segments(self):
        return {sid: (p, q) for sid, (p, q) in self._segments.items()}

    @property
    def vertices(self):
        return self.topology.vertices

    @property
    def edges(self):
        return self.topology.edges

    @property
    def halfedges(self):
        return self.topology.halfedges

    @property
    def faces(self):
        return self.topology.faces

    def edge_id_map(self):
        """Map edge id -> (p, q, sources) for the current topology."""
        return dict(self._prev_edge_sig)

    def segments_touching(self, sids):
        """Source ids whose closed segments meet any of ``sids`` (exact)."""
        probe = [self._segments[s] for s in sids if s in self._segments]
        out = set(sids)
        for sid, (p, q) in self._segments.items():
            if sid in out:
                continue
            for a, b in probe:
                if _segments_meet(p, q, a, b):
                    out.add(sid)
                    break
        return sorted(out)

    # ------------------------------------------------------------------ #
    # serialization
    # ------------------------------------------------------------------ #
    def to_dict(self):
        from .serialize import arrangement_to_dict
        return arrangement_to_dict(self)

    @classmethod
    def from_dict(cls, data):
        from .serialize import arrangement_from_dict
        return arrangement_from_dict(data)


def _segments_meet(p, q, a, b):
    """Exact test: closed segments p-q and a-b share at least one point."""
    from .geometry import line_intersection, line_key
    if p == q:
        return on_segment(p, a, b) if a != b else p == a
    if a == b:
        return on_segment(a, p, q)
    if line_key(p, q) == line_key(a, b):
        return (on_segment(p, a, b) or on_segment(q, a, b)
                or on_segment(a, p, q) or on_segment(b, p, q))
    pt = line_intersection(p, q, a, b)
    if pt is None:
        return False
    return on_segment(pt, p, q) and on_segment(pt, a, b)
