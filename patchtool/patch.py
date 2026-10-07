"""Patch construction: diff two trees into a minimal, executable patch.

A patch JSON object looks like::

    {"version": 1,
     "cost": <int>,
     "ops":   [normalised operations, sorted lexicographically],
     "plan":  [executable steps in a safe order],
     "src_fingerprints": {path: sha256},
     "dst_fingerprints": {path: sha256},
     "certificate": {dual-potential optimality proof}}

Operations (``ops``) are self-contained and cost-additive:
``add``/``delete`` cost the byte size of the content, ``modify`` costs the
shortest line edit script length, ``rename`` costs path edit distance plus
content edit script length.  A path swap is represented as a rename
2-cycle; the execution plan breaks rename cycles with temporary names that
collide with no input path.
"""
from __future__ import annotations

from .matching import CostModel, canonical_ops, hungarian
from .model import byte_count, parent_paths
from .distance import content_distance, path_distance


def op_key(op):
    """Normalised sortable key of an operation dict."""
    if op["op"] == "rename":
        return ("rename", op["src"], op["dst"])
    return (op["op"], op["path"])


def _op_dicts(op_tuples, model):
    src_lines = dict(model.src)
    dst_lines = dict(model.dst)
    ops = []
    for op in op_tuples:
        kind = op[0]
        if kind == "add":
            lines = dst_lines[op[1]]
            ops.append({"op": "add", "path": op[1], "lines": list(lines),
                        "cost": byte_count(lines)})
        elif kind == "delete":
            ops.append({"op": "delete", "path": op[1],
                        "cost": byte_count(src_lines[op[1]])})
        elif kind == "modify":
            lines = dst_lines[op[1]]
            ops.append({"op": "modify", "path": op[1], "lines": list(lines),
                        "cost": content_distance(src_lines[op[1]], lines)})
        else:  # rename
            s, d = op[1], op[2]
            lines = dst_lines[d]
            ops.append({"op": "rename", "src": s, "dst": d,
                        "lines": list(lines),
                        "cost": path_distance(s, d)
                        + content_distance(src_lines[s], lines)})
    return ops


class PlanError(RuntimeError):
    """Raised when no executable step ordering can be found."""


def build_plan(src_tree, dst_tree, op_tuples, model):
    """Order operations into executable steps.

    Handles rename cycles (via temporary names disjoint from every input
    path), file<->directory type changes, and missing/extra directories.
    """
    src_lines = dict(model.src)
    dst_lines = dict(model.dst)
    current_files = dict(model.src)
    current_dirs = set(src_tree.all_dirs)
    needed_dirs = set(dst_tree.all_dirs)
    mkdir_set = needed_dirs - current_dirs
    rmdir_set = current_dirs - needed_dirs

    steps = []
    deletes = []
    renames = {}
    modifies = {}
    adds = {}
    for op in op_tuples:
        if op[0] == "delete":
            deletes.append(op[1])
        elif op[0] == "add":
            adds[op[1]] = dst_lines[op[1]]
        elif op[0] == "modify":
            modifies[op[1]] = dst_lines[op[1]]
        else:  # rename
            renames[op[1]] = op[2]
            if src_lines[op[1]] != dst_lines[op[2]]:
                modifies[op[2]] = dst_lines[op[2]]

    for p in sorted(deletes):
        steps.append({"step": "delete", "path": p})
        current_files.pop(p, None)

    pending = dict(renames)
    tmp_counter = 0

    def fresh_temp():
        nonlocal tmp_counter
        while True:
            cand = f".patch-tmp-{tmp_counter}"
            tmp_counter += 1
            if (cand not in current_files and cand not in current_dirs
                    and cand not in src_tree.files and cand not in dst_tree.files
                    and cand not in src_tree.all_dirs
                    and cand not in dst_tree.all_dirs):
                return cand

    def is_empty_dir(d):
        pre = d + "/"
        return (not any(f.startswith(pre) for f in current_files)
                and not any(x != d and x.startswith(pre) for x in current_dirs))

    guard = 0
    while pending:
        guard += 1
        if guard > 4 * (len(pending) + 2) * (len(pending) + 2) + 100:
            raise PlanError("cannot order rename steps")
        progressed = False
        for s in sorted(pending):
            d = pending[s]
            if d in current_files:
                continue  # occupied by another pending rename (or a cycle)
            if d in current_dirs:
                if d in rmdir_set and is_empty_dir(d):
                    steps.append({"step": "rmdir", "path": d})
                    current_dirs.discard(d)
                    rmdir_set.discard(d)
                    progressed = True
                    break
                continue
            missing = None
            for anc in parent_paths(d):
                if anc not in current_dirs:
                    missing = anc
                    break
            if missing is not None:
                if missing not in current_files:
                    steps.append({"step": "mkdir", "path": missing})
                    current_dirs.add(missing)
                    mkdir_set.discard(missing)
                    progressed = True
                    break
                continue  # directory slot still occupied by a pending rename
            steps.append({"step": "rename", "src": s, "dst": d})
            current_files[d] = current_files.pop(s)
            del pending[s]
            progressed = True
            break
        if not progressed:
            # Remove any empty directory scheduled for deletion (deepest
            # first); it may be blocking a rename target or a mkdir.
            for d in sorted(rmdir_set, key=lambda p: (-p.count("/"), p)):
                if is_empty_dir(d):
                    steps.append({"step": "rmdir", "path": d})
                    current_dirs.discard(d)
                    rmdir_set.discard(d)
                    progressed = True
                    break
        if not progressed:
            # Create any needed directory whose parent already exists and
            # whose slot is free (shallowest first).
            for d in sorted(mkdir_set, key=lambda p: (p.count("/"), p)):
                if d in current_files or d in current_dirs:
                    continue
                if all(anc in current_dirs for anc in parent_paths(d)):
                    steps.append({"step": "mkdir", "path": d})
                    current_dirs.add(d)
                    mkdir_set.discard(d)
                    progressed = True
                    break
        if not progressed:
            # Rename cycle or rename/mkdir deadlock (including 2-cycles,
            # i.e. path swaps): park the *blocking* file under a temporary
            # name that collides with no input path.  A non-progressable
            # state always has such a blocker: every pending rename is
            # either blocked by a file at its target or by a file where it
            # needs a parent directory.
            victim = None
            for s in sorted(pending):
                d = pending[s]
                blockers = []
                if d in current_files:
                    blockers.append(d)
                blockers += [anc for anc in parent_paths(d)
                             if anc in current_files]
                for cand in blockers:
                    if cand in pending and (victim is None or cand < victim):
                        victim = cand
            if victim is None:
                victim = sorted(pending)[0]
            t = fresh_temp()
            steps.append({"step": "rename", "src": victim, "dst": t})
            current_files[t] = current_files.pop(victim)
            pending[t] = pending.pop(victim)

    for d in sorted(rmdir_set, key=lambda p: (-p.count("/"), p)):
        steps.append({"step": "rmdir", "path": d})
        current_dirs.discard(d)
    for d in sorted(mkdir_set, key=lambda p: (p.count("/"), p)):
        steps.append({"step": "mkdir", "path": d})
        current_dirs.add(d)
    for p in sorted(adds):
        steps.append({"step": "add", "path": p, "lines": list(adds[p])})
    for p in sorted(modifies):
        steps.append({"step": "modify", "path": p, "lines": list(modifies[p])})
    return steps


def diff_trees(src_tree, dst_tree):
    """Compute the minimum-cost executable patch from ``src_tree`` to
    ``dst_tree`` together with an optimality certificate."""
    src_files = sorted(src_tree.files.items())
    dst_files = sorted(dst_tree.files.items())
    model = CostModel(src_files, dst_files)
    _match, u, v, optimum = hungarian(model.matrix)
    op_tuples, assignment = canonical_ops(model, optimum)
    ops = _op_dicts(op_tuples, model)
    plan = build_plan(src_tree, dst_tree, op_tuples, model)
    from .certificate import build_certificate
    cert = build_certificate(model, assignment, u, v, optimum,
                             src_tree.tree_hash(), dst_tree.tree_hash())
    return {
        "version": 1,
        "cost": optimum,
        "ops": ops,
        "plan": plan,
        "src_fingerprints": src_tree.file_fingerprints(),
        "dst_fingerprints": dst_tree.file_fingerprints(),
        "certificate": cert,
    }
