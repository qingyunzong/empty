"""Independent evidence checker.

This module deliberately shares no search/propagation logic with the
solver.  It re-derives everything directly from the instance:

* sat evidence: a complete integer schedule, checked against every
  difference constraint and every disjunct;
* unsat evidence: a branch conflict tree whose leaves are negative
  cycles, replayed independently (edges are rebuilt from the instance
  plus the decisions along each root-to-leaf path);
* unknown evidence: a partial candidate, checked against the static
  constraints and the decided orderings only.
"""

from __future__ import annotations

from .solver import InputError

ZERO_TOKEN = "zero"


class Instance:
    __slots__ = ("num_tasks", "durations", "constraints", "disjuncts", "zero")

    def __init__(self, num_tasks, durations, constraints, disjuncts):
        self.num_tasks = num_tasks
        self.durations = durations
        self.constraints = constraints
        self.disjuncts = disjuncts
        self.zero = num_tasks


def _int(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputError(f"{name} must be an integer, got {value!r}")
    return value


def _var(value, num_tasks, name):
    if value == ZERO_TOKEN:
        return num_tasks
    value = _int(value, name)
    if not 0 <= value <= num_tasks:
        raise InputError(f"{name} out of range: {value}")
    return value


def parse_instance(data):
    """Validate a JSON instance and return an Instance.

    Format::
        {"num_tasks": n, "durations": [d0, ...],
         "constraints": [{"u": i, "v": j, "w": c}, ...],   # x_v - x_u <= c
         "disjuncts": [[a, b], ...]}
    ``u``/``v`` may be a task index, n (the zero variable) or "zero".
    """
    if not isinstance(data, dict):
        raise InputError("instance must be a JSON object")
    num_tasks = _int(data.get("num_tasks"), "num_tasks")
    if num_tasks < 0:
        raise InputError("num_tasks must be >= 0")
    durations = data.get("durations")
    if not isinstance(durations, list) or len(durations) != num_tasks:
        raise InputError("durations must be a list with one entry per task")
    durs = []
    for d in durations:
        _int(d, "duration")
        if d <= 0:
            raise InputError(f"durations must be positive, got {d}")
        durs.append(d)
    constraints = []
    raw = data.get("constraints", [])
    if not isinstance(raw, list):
        raise InputError("constraints must be a list")
    for i, c in enumerate(raw):
        if not isinstance(c, dict):
            raise InputError(f"constraint {i} must be an object")
        u = _var(c.get("u"), num_tasks, f"constraint {i} u")
        v = _var(c.get("v"), num_tasks, f"constraint {i} v")
        w = _int(c.get("w"), f"constraint {i} w")
        constraints.append((u, v, w))
    disjuncts = []
    raw = data.get("disjuncts", [])
    if not isinstance(raw, list):
        raise InputError("disjuncts must be a list")
    for i, pair in enumerate(raw):
        if not isinstance(pair, list) or len(pair) != 2:
            raise InputError(f"disjunct {i} must be a [a, b] pair")
        a = _int(pair[0], f"disjunct {i} a")
        b = _int(pair[1], f"disjunct {i} b")
        for t in (a, b):
            if not 0 <= t < num_tasks:
                raise InputError(f"disjunct {i} references unknown task {t}")
        if a == b:
            raise InputError(f"disjunct {i} endpoints must differ")
        disjuncts.append((a, b))
    return Instance(num_tasks, durs, constraints, disjuncts)


def _decision_edge(inst, k, choice):
    """Edge induced by deciding disjunct k (independent re-derivation)."""
    a, b = inst.disjuncts[k]
    if choice == 0:   # a finishes before b starts
        return (b, a, -inst.durations[a])
    return (a, b, -inst.durations[b])


def check_schedule(inst, schedule):
    """Verify a complete integer schedule.  Returns (ok, reason)."""
    if not isinstance(schedule, list) or len(schedule) != inst.num_tasks:
        return False, "schedule must be a list with one entry per task"
    for s in schedule:
        if isinstance(s, bool) or not isinstance(s, int):
            return False, "schedule entries must be integers"
    times = list(schedule) + [0]
    for i, (u, v, w) in enumerate(inst.constraints):
        if times[v] - times[u] > w:
            return False, f"constraint {i} violated: x_{v} - x_{u} = {times[v] - times[u]} > {w}"
    for k, (a, b) in enumerate(inst.disjuncts):
        before = times[a] + inst.durations[a] <= times[b]
        after = times[b] + inst.durations[b] <= times[a]
        if not (before or after):
            return False, f"disjunct {k} violated: tasks {a} and {b} overlap"
    return True, "ok"


def check_candidate(inst, candidate):
    """Verify an 'unknown' candidate against decided constraints only."""
    if not isinstance(candidate, dict):
        return False, "candidate must be an object"
    schedule = candidate.get("schedule")
    if not isinstance(schedule, list) or len(schedule) != inst.num_tasks:
        return False, "candidate schedule must have one entry per task"
    for s in schedule:
        if isinstance(s, bool) or not isinstance(s, int):
            return False, "candidate schedule entries must be integers"
    times = list(schedule) + [0]
    for i, (u, v, w) in enumerate(inst.constraints):
        if times[v] - times[u] > w:
            return False, f"candidate violates static constraint {i}"
    decisions = candidate.get("decisions", {})
    if not isinstance(decisions, dict):
        return False, "candidate decisions must be an object"
    for key, choice in decisions.items():
        try:
            k = int(key)
        except (TypeError, ValueError):
            return False, f"bad decision key {key!r}"
        if not 0 <= k < len(inst.disjuncts):
            return False, f"candidate decides unknown disjunct {k}"
        if choice not in (0, 1):
            return False, f"decision for disjunct {k} must be 0 or 1"
        a, b = inst.disjuncts[k]
        if choice == 0 and not times[a] + inst.durations[a] <= times[b]:
            return False, f"candidate violates decided ordering of disjunct {k}"
        if choice == 1 and not times[b] + inst.durations[b] <= times[a]:
            return False, f"candidate violates decided ordering of disjunct {k}"
    return True, "ok"


def check_conflict_tree(inst, tree):
    """Replay a branch conflict tree independently.  Returns (ok, reason)."""
    return _check_node(inst, tree, {})


def _check_node(inst, node, decided):
    if not isinstance(node, dict):
        return False, "tree node must be an object"
    ntype = node.get("type")
    if ntype == "leaf":
        return _check_leaf(inst, node, decided)
    if ntype == "branch":
        k = node.get("disjunct")
        if isinstance(k, bool) or not isinstance(k, int) or not 0 <= k < len(inst.disjuncts):
            return False, f"branch references unknown disjunct {k!r}"
        if k in decided:
            return False, f"disjunct {k} is branched twice on one path"
        children = node.get("children")
        if not isinstance(children, list) or len(children) != 2:
            return False, "branch node must have exactly two children"
        for choice in (0, 1):
            sub = dict(decided)
            sub[k] = choice
            ok, reason = _check_node(inst, children[choice], sub)
            if not ok:
                return False, f"branch disjunct {k} choice {choice}: {reason}"
        return True, "ok"
    return False, f"unknown tree node type {ntype!r}"


def _check_leaf(inst, node, decided):
    cycle = node.get("cycle")
    weight = node.get("weight")
    if not isinstance(cycle, list) or not cycle:
        return False, "leaf cycle must be a non-empty list of edge tags"
    if isinstance(weight, bool) or not isinstance(weight, int):
        return False, "leaf weight must be an integer"
    edges = []
    for tag in cycle:
        if not isinstance(tag, list) or len(tag) != 2:
            return False, f"malformed edge tag {tag!r}"
        kind, idx = tag
        if isinstance(idx, bool) or not isinstance(idx, int):
            return False, f"malformed edge index in tag {tag!r}"
        if kind == "static":
            if not 0 <= idx < len(inst.constraints):
                return False, f"unknown static constraint {idx}"
            edges.append(inst.constraints[idx])
        elif kind == "decision":
            if not 0 <= idx < len(inst.disjuncts):
                return False, f"unknown disjunct {idx}"
            if idx not in decided:
                return False, f"cycle uses disjunct {idx} which is not decided on this path"
            edges.append(_decision_edge(inst, idx, decided[idx]))
        else:
            return False, f"unknown edge tag kind {kind!r}"
    # structural check: the edges must form exactly one simple directed cycle
    succ = {}
    indeg = {}
    for (u, v, w) in edges:
        succ.setdefault(u, []).append((v, w))
        indeg[v] = indeg.get(v, 0) + 1
    for u, lst in succ.items():
        if len(lst) != 1:
            return False, "cycle edges do not form a simple directed cycle"
    for v, d in indeg.items():
        if d != 1 or v not in succ:
            return False, "cycle edges do not form a simple directed cycle"
    start = edges[0][0]
    total = 0
    steps = 0
    x = start
    while True:
        if x not in succ:
            return False, "cycle edges are not connected"
        v, w = succ[x][0]
        total += w
        steps += 1
        x = v
        if x == start:
            break
        if steps > len(edges):
            return False, "cycle does not close"
    if steps != len(edges):
        return False, "cycle edges form more than one cycle"
    if total >= 0:
        return False, f"cycle weight {total} is not negative"
    if total != weight:
        return False, f"claimed weight {weight} does not match actual {total}"
    return True, "ok"


def check_evidence(inst, evidence):
    """Dispatch on evidence status.  Returns (ok, reason)."""
    if not isinstance(evidence, dict):
        return False, "evidence must be an object"
    status = evidence.get("status")
    if status == "sat":
        cert = evidence.get("certificate", evidence)
        if not isinstance(cert, dict):
            return False, "sat certificate must be an object"
        return check_schedule(inst, cert.get("schedule"))
    if status == "unsat":
        cert = evidence.get("certificate", evidence)
        if not isinstance(cert, dict):
            return False, "unsat certificate must be an object"
        return check_conflict_tree(inst, cert.get("tree"))
    if status == "unknown":
        return check_candidate(inst, evidence.get("candidate"))
    return False, f"unknown evidence status {status!r}"
