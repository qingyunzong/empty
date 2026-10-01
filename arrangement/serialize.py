"""JSON-compatible serialization of an Arrangement.

Fractions are encoded as integers when integral, otherwise as "p/q"
strings, so files stay human readable and exactly round-trippable.
"""

from __future__ import annotations

from fractions import Fraction


def frac_to_json(value: Fraction):
    if value.denominator == 1:
        return int(value)
    return f"{value.numerator}/{value.denominator}"


def point_to_json(pt):
    return [frac_to_json(pt[0]), frac_to_json(pt[1])]


def arrangement_to_dict(arr):
    return {
        "format": "arrangement/1",
        "next_sid": arr._next_sid,
        "next_vid": arr._next_vid,
        "next_eid": arr._next_eid,
        "segments": [
            {"id": sid, "p": point_to_json(p), "q": point_to_json(q)}
            for sid, (p, q) in sorted(arr._segments.items())
        ],
        "vertex_ids": [
            {"point": point_to_json(pt), "id": vid}
            for pt, vid in sorted(arr._vid_of.items(), key=lambda kv: kv[1])
        ],
        "edge_ids": [
            {"p": point_to_json(p), "q": point_to_json(q), "id": eid}
            for (p, q), eid in sorted(arr._eid_of.items(), key=lambda kv: kv[1])
        ],
    }


def arrangement_from_dict(data):
    from .arrangement import Arrangement
    from .geometry import make_point

    if data.get("format") != "arrangement/1":
        raise ValueError("unsupported arrangement format")
    arr = Arrangement()
    arr._next_sid = data["next_sid"]
    arr._next_vid = data["next_vid"]
    arr._next_eid = data["next_eid"]
    arr._segments = {
        item["id"]: (make_point(item["p"]), make_point(item["q"]))
        for item in data["segments"]
    }
    arr._vid_of = {
        make_point(item["point"]): item["id"] for item in data["vertex_ids"]
    }
    arr._eid_of = {
        (make_point(item["p"]), make_point(item["q"])): item["id"]
        for item in data["edge_ids"]
    }
    arr._rebuild()
    return arr
