"""Shared helpers for the rknni test suite."""

import random

from rknni.exact import dist2, idkey, parse_vector, point_in_bbox
from rknni.filters import match_tags


def brute_force(points, vector, k, filt=None):
    """Test-local independent full scan, returns list of (id, dist)."""
    q = parse_vector(vector)
    cands = []
    for p in points:
        if filt is not None and not match_tags(filt, p.tags):
            continue
        cands.append((dist2(p.vector, q), idkey(p.id), p.id))
    cands.sort()
    return [(pid, d) for d, _, pid in cands[:k]]


def random_vector(rng, dim, lo=-100, hi=100, denoms=(1, 2, 4)):
    from fractions import Fraction

    return [
        Fraction(rng.randint(lo, hi), rng.choice(denoms))
        for _ in range(dim)
    ]


def subtree_points(node):
    if node.leaf:
        return list(node.entries)
    pts = []
    for child in node.children:
        pts.extend(subtree_points(child))
    return pts


def check_tree_invariants(testcase, idx):
    """Bounds must never over-shrink; summaries must stay conservative."""

    def rec(node):
        pts = subtree_points(node)
        if pts:
            testcase.assertIsNotNone(node.bbox)
            for p in pts:
                testcase.assertTrue(
                    point_in_bbox(node.bbox, p.vector),
                    f"node {node.node_id} bbox does not cover point {p.id}",
                )
            union = set().union(*(p.tags for p in pts))
            inter = set(pts[0].tags)
            for p in pts[1:]:
                inter &= p.tags
            testcase.assertLessEqual(union, node.tags_any)
            testcase.assertLessEqual(node.tags_all, inter)
        else:
            testcase.assertIsNone(node.bbox)
        if not node.leaf:
            testcase.assertTrue(node.children)
            for child in node.children:
                testcase.assertIs(child.parent, node)
                rec(child)

    rec(idx.root)
    for pid, leaf in idx._leaf_of.items():
        testcase.assertTrue(any(p.id == pid for p in leaf.entries))
    testcase.assertEqual(len(idx._points), len(idx._leaf_of))


def make_index(rng, n, dim=3, capacity=6, fanout=6, tags=("a", "b", "c")):
    from rknni import Index

    idx = Index(dim, capacity=capacity, fanout=fanout)
    for i in range(n):
        point_tags = [t for t in tags if rng.random() < 0.4]
        idx.insert(i, random_vector(rng, dim), tags=point_tags, version=1)
    return idx
