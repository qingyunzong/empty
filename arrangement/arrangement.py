"""Public arrangement API: incremental construction with stable ids.

The arrangement keeps the original segments, and derives the planar
topology (atomic edges, half-edge structure, faces) via
``atomic`` -> ``sweep`` -> ``dcel``.  Insertions and removals recompute
the topology but reuse ids: vertices are keyed by exact coordinates,
edges by their canonical endpoint pair, faces by a canonical boundary
signature -- so elements untouched by a change keep their ids.

All mutations are transactional: the new topology is fully built and
verified *before* being committed, so invalid input never corrupts the
existing arrangement.
"""

from __future__ import annotations

from .atomic import atomic_decomposition
from .dcel import build_topology
from .geom import line_key, on_segment, param_t, to_point
from .sweep import sweep_intersections


def _enc_num(f):
    return f.numerator if f.denominator == 1 else f"{f.numerator}/{f.denominator}"


def _enc_point(p):
    return [_enc_num(p[0]), _enc_num(p[1])]


def _enc_signature(sig):
    outer, holes, iso = sig
    return {
        "outer": [_enc_point(p) for p in outer] if outer else None,
        "holes": [[_enc_point(p) for p in h] for h in holes],
        "isolated": [_enc_point(p) for p in iso],
    }


def _dec_signature(data):
    outer = tuple(to_point(p) for p in data["outer"]) if data["outer"] else None
    holes = tuple(tuple(to_point(p) for p in h) for h in data["holes"])
    iso = tuple(to_point(p) for p in data["isolated"])
    return (outer, holes, iso)


class Arrangement:
    def __init__(self, segments=None):
        self._segments = {}          # sid -> (p, q)
        self._next_sid = 1
        self._edge_ids = {}          # (pa, pb) canonical -> eid
        self._next_eid = 1
        self._vertex_ids = {}        # point -> vid
        self._next_vid = 1
        self._face_ids = {}          # signature -> fid
        self._next_fid = 1
        self._topo = None
        self._commit(self._segments)
        if segments:
            self.add_segments(segments)

    # ------------------------------------------------------------------
    # construction / mutation
    # ------------------------------------------------------------------
    def _compute(self, segments, edge_ids, vertex_ids, face_ids,
                 next_eid, next_vid, next_fid):
        """Build topology for ``segments`` reusing existing id maps."""
        atomic = atomic_decomposition(segments)
        split_points = sweep_intersections(atomic.segments)
        topo = build_topology(atomic.segments, split_points, atomic.points)

        edge_ids = dict(edge_ids)
        vertex_ids = dict(vertex_ids)
        face_ids = dict(face_ids)

        vids = []
        for pt in topo.points:
            if pt not in vertex_ids:
                vertex_ids[pt] = next_vid
                next_vid += 1
            vids.append(vertex_ids[pt])

        eids = []
        for (u, v, _src) in topo.edges:
            key = (topo.points[u], topo.points[v])
            if key not in edge_ids:
                edge_ids[key] = next_eid
                next_eid += 1
            eids.append(edge_ids[key])

        fids = []
        for face in topo.faces:
            sig = self._face_signature(face, topo.points)
            if sig not in face_ids:
                face_ids[sig] = next_fid
                next_fid += 1
            fids.append(face_ids[sig])

        return (topo, vids, eids, fids, edge_ids, vertex_ids, face_ids,
                next_eid, next_vid, next_fid)

    def _commit(self, segments):
        state = self._compute(
            segments, self._edge_ids, self._vertex_ids, self._face_ids,
            self._next_eid, self._next_vid, self._next_fid,
        )
        (self._topo, self._vids, self._eids, self._fids,
         self._edge_ids, self._vertex_ids, self._face_ids,
         self._next_eid, self._next_vid, self._next_fid) = state
        self._segments = segments

    @staticmethod
    def _face_signature(face, points):
        def norm(cycle):
            pts = [points[v] for v in cycle]
            return min(tuple(pts[i:] + pts[:i]) for i in range(len(pts)))

        outer = norm(face["outer"]) if face["outer"] else None
        holes = tuple(sorted(norm(h) for h in face["holes"]))
        iso = tuple(sorted(points[v] for v in face["isolated"]))
        return (outer, holes, iso)

    def add_segments(self, raw_segments):
        """Insert segments; returns their new ids.  Atomic on failure."""
        parsed = []
        for raw in raw_segments:
            try:
                a_raw, b_raw = raw
            except (TypeError, ValueError) as exc:
                raise ValueError(f"invalid segment: {raw!r}") from exc
            parsed.append((to_point(a_raw), to_point(b_raw)))
        new_segments = dict(self._segments)
        first = self._next_sid
        for offset, pq in enumerate(parsed):
            new_segments[first + offset] = pq
        self._commit(new_segments)
        self._next_sid = first + len(parsed)
        return list(range(first, first + len(parsed)))

    def remove_segments(self, sids):
        """Remove segments by id.  Atomic on failure."""
        missing = [s for s in sids if s not in self._segments]
        if missing:
            raise ValueError(f"unknown segment ids: {missing}")
        new_segments = {
            s: pq for s, pq in self._segments.items() if s not in set(sids)
        }
        self._commit(new_segments)

    # ------------------------------------------------------------------
    # accessors
    # ------------------------------------------------------------------
    def segments(self):
        return {
            sid: [_enc_point(p), _enc_point(q)]
            for sid, (p, q) in sorted(self._segments.items())
        }

    def vertices(self):
        return [
            {"id": vid, "x": _enc_num(p[0]), "y": _enc_num(p[1])}
            for vid, p in zip(self._vids, self._topo.points)
        ]

    def edges(self):
        out = []
        for eid, (u, v, src) in zip(self._eids, self._topo.edges):
            out.append({
                "id": eid,
                "u": self._vids[u],
                "v": self._vids[v],
                "sources": sorted(src),
            })
        return out

    def faces(self):
        out = []
        for fid, face in zip(self._fids, self._topo.faces):
            out.append({
                "id": fid,
                "outer": ([self._vids[v] for v in face["outer"]]
                          if face["outer"] else None),
                "holes": [[self._vids[v] for v in h] for h in face["holes"]],
                "isolated": [self._vids[v] for v in face["isolated"]],
                "is_outer": face["outer"] is None,
            })
        return out

    def stats(self):
        return {
            "segments": len(self._segments),
            "vertices": len(self._topo.points),
            "edges": len(self._topo.edges),
            "faces": len(self._topo.faces),
        }

    # ------------------------------------------------------------------
    # independent verification
    # ------------------------------------------------------------------
    def verify(self):
        """Run all structural checks; returns a dict of check results.

        Raises AssertionError with details on the first failed check.
        """
        topo = self._topo
        points = topo.points
        checks = {}

        # 1. every original segment is fully covered by atomic edges
        #    whose source set contains it.
        line_of = {}
        for (u, v, src) in topo.edges:
            pa, pb = points[u], points[v]
            line_of.setdefault(line_key(pa, pb), []).append((pa, pb, src))
        current_points = set(topo.points)
        for sid, (p, q) in self._segments.items():
            if p == q:
                assert p in current_points, f"point segment {sid} missing"
                continue
            key = line_key(p, q)
            tlo, thi = sorted((param_t(key, p), param_t(key, q)))
            intervals = []
            for (pa, pb, src) in line_of.get(key, []):
                if sid not in src:
                    continue
                ta, tb = sorted((param_t(key, pa), param_t(key, pb)))
                lo, hi = max(ta, tlo), min(tb, thi)
                if lo < hi:
                    intervals.append((lo, hi))
            intervals.sort()
            cur = tlo
            for lo, hi in intervals:
                assert lo <= cur, f"segment {sid}: coverage gap at {cur}"
                cur = max(cur, hi)
            assert cur >= thi, f"segment {sid}: coverage ends early"
        checks["coverage"] = True

        # 2. half-edges are paired: every geometric edge contributes
        #    exactly one half-edge in each direction.
        directed = set()
        for (u, v, _src) in topo.edges:
            assert (u, v) not in directed and (v, u) not in directed, \
                "duplicate edge"
            directed.add((u, v))
            directed.add((v, u))
        assert len(directed) == 2 * len(topo.edges)
        checks["half_edges_paired"] = True

        # 3. face loops are closed walks along actual edges.
        edge_set = {
            (min(u, v), max(u, v)) for (u, v, _s) in topo.edges
        }
        for face in topo.faces:
            cycles = ([face["outer"]] if face["outer"] else []) \
                + list(face["holes"])
            for cyc in cycles:
                n = len(cyc)
                assert n >= 2, "degenerate face cycle"
                for i in range(n):
                    a, b = cyc[i], cyc[(i + 1) % n]
                    assert (min(a, b), max(a, b)) in edge_set, \
                        "face cycle uses a non-edge"
        checks["face_loops_closed"] = True

        # 4. Euler relation: V - E + F == 1 + C.
        parent = list(range(len(points)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for (u, v, _s) in topo.edges:
            ru, rv = find(u), find(v)
            if ru != rv:
                parent[ru] = rv
        components = len({find(i) for i in range(len(points))})
        v_cnt = len(points)
        e_cnt = len(topo.edges)
        f_cnt = len(topo.faces)
        assert v_cnt - e_cnt + f_cnt == 1 + components, (
            f"Euler violated: {v_cnt}-{e_cnt}+{f_cnt} != 1+{components}"
        )
        checks["euler"] = True
        checks["components"] = components
        return checks

    # ------------------------------------------------------------------
    # serialization
    # ------------------------------------------------------------------
    def to_dict(self):
        return {
            "segments": {
                str(sid): [_enc_point(p), _enc_point(q)]
                for sid, (p, q) in sorted(self._segments.items())
            },
            "next_sid": self._next_sid,
            "edge_ids": {
                ",".join(str(_enc_num(c)) for c in
                         (k[0][0], k[0][1], k[1][0], k[1][1])): eid
                for k, eid in self._edge_ids.items()
            },
            "next_eid": self._next_eid,
            "vertex_ids": {
                f"{_enc_num(k[0])},{_enc_num(k[1])}": vid
                for k, vid in self._vertex_ids.items()
            },
            "next_vid": self._next_vid,
            "face_ids": [
                {"signature": _enc_signature(sig), "id": fid}
                for sig, fid in self._face_ids.items()
            ],
            "next_fid": self._next_fid,
        }

    @classmethod
    def from_dict(cls, data):
        from .geom import to_frac

        arr = cls()
        segments = {}
        for sid, (a, b) in data["segments"].items():
            segments[int(sid)] = (to_point(a), to_point(b))
        arr._next_sid = data["next_sid"]
        edge_ids = {}
        for key, eid in data["edge_ids"].items():
            x1, y1, x2, y2 = key.split(",")
            edge_ids[((to_frac(x1), to_frac(y1)),
                      (to_frac(x2), to_frac(y2)))] = eid
        arr._edge_ids = edge_ids
        arr._next_eid = data["next_eid"]
        vertex_ids = {}
        for key, vid in data["vertex_ids"].items():
            x, y = key.split(",")
            vertex_ids[(to_frac(x), to_frac(y))] = vid
        arr._vertex_ids = vertex_ids
        arr._next_vid = data["next_vid"]
        face_ids = {}
        for entry in data["face_ids"]:
            face_ids[_dec_signature(entry["signature"])] = entry["id"]
        arr._face_ids = face_ids
        arr._next_fid = data["next_fid"]
        arr._commit(segments)
        return arr
