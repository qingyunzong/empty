"""Shared helpers: random trees and brute-force optimal matching."""
from __future__ import annotations

import itertools

from filepatch.costs import add_cost, delete_cost, pair_cost
from filepatch.matching import pair_operation

PATH_POOL = [
    "a",
    "b",
    "c",
    "d",
    "f1",
    "f2",
    "a/x",
    "a/y",
    "dir1/f",
    "dir1/g",
    "dir2/h",
    "x",
    "y",
    "z",
]

LINE_POOL = [
    [],
    ["x"],
    ["y"],
    ["same"],
    ["same"],
    ["a", "b"],
    ["b", "a"],
    ["l1", "l2", "l3"],
    ["l1", "l2"],
]


def random_files(rng, count):
    """Build a valid random file mapping with up to ``count`` files."""
    chosen = []
    pool = PATH_POOL[:]
    rng.shuffle(pool)
    for path in pool:
        if len(chosen) >= count:
            break
        if any(
            path.startswith(p + "/") or p.startswith(path + "/") for p in chosen
        ):
            continue
        chosen.append(path)
    return {path: list(rng.choice(LINE_POOL)) for path in chosen}


def matching_key(source_files, target_files, mapping):
    """Return ``(cost, sorted_op_tuple)`` for one matching.

    ``mapping`` maps every source path to a target path or ``None``
    (deletion); targets not used as values are additions.
    """
    used_targets = set()
    cost = 0
    ops = []
    for src, dst in mapping.items():
        if dst is None:
            cost += delete_cost(source_files[src])
            ops.append(("delete", src))
        else:
            used_targets.add(dst)
            cost += pair_cost(
                src, source_files[src], dst, target_files[dst]
            )
            ops.append(
                pair_operation(
                    src, source_files[src], dst, target_files[dst]
                )
            )
    for dst in sorted(target_files):
        if dst not in used_targets:
            cost += add_cost(target_files[dst])
            ops.append(("add", dst))
    return cost, tuple(sorted(ops))


def brute_force_best(source_files, target_files):
    """Exhaustively find the best ``(cost, sorted_op_tuple)``."""
    s_paths = sorted(source_files)
    t_paths = sorted(target_files)
    best = None
    for k in range(min(len(s_paths), len(t_paths)) + 1):
        for srcs in itertools.combinations(s_paths, k):
            deleted = [s for s in s_paths if s not in srcs]
            for dsts in itertools.combinations(t_paths, k):
                for perm in itertools.permutations(dsts):
                    mapping = {s: None for s in deleted}
                    mapping.update(zip(srcs, perm))
                    key = matching_key(source_files, target_files, mapping)
                    if best is None or key < best:
                        best = key
    return best
