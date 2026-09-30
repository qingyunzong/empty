"""Independent evidence checker.

Deliberately shares no code with the solver or the constraint engine: every
verification below is a direct, naive re-computation from the instance data
(direct constraint evaluation, explicit cycle weight summation, structural
tree replay).  No propagation, no pruning logic is reused.

Instance format (dict / JSON):
    {
      "n_tasks": int,
      "durations": [positive int, ...],
      "constraints": [{"u": int, "v": int, "c": int, "uid": str?}, ...],
                       meaning  x_v - x_u <= c ; uid defaults to "k<index>"
      "disjuncts": [[i, j], ...]
    }
"""

from __future__ import annotations


class CheckFailure(Exception):
    pass


def _fail(reason):
    raise CheckFailure(reason)


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


# ------------------------------------------------------------------ instance

def validate_instance(inst):
    """Return (n, durations, base_edges, disjuncts) or raise CheckFailure.

    base_edges maps uid -> (u, v, c)."""
    if not isinstance(inst, dict):
        _fail("instance must be an object")
    n = inst.get("n_tasks")
    durations = inst.get("durations")
    if not _is_int(n) or n <= 0:
        _fail("n_tasks must be a positive integer")
    if not isinstance(durations, list) or len(durations) != n:
        _fail("durations must be a list of length n_tasks")
    for d in durations:
        if not _is_int(d) or d <= 0:
            _fail("all durations must be positive integers")
    base_edges = {}
    constraints = inst.get("constraints", [])
    if not isinstance(constraints, list):
        _fail("constraints must be a list")
    for pos, con in enumerate(constraints):
        if not isinstance(con, dict):
            _fail(f"constraint {pos} must be an object")
        u, v, c = con.get("u"), con.get("v"), con.get("c")
        uid = con.get("uid", f"k{pos}")
        if not _is_int(u) or not _is_int(v) or not (0 <= u < n) or not (0 <= v < n):
            _fail(f"constraint {uid!r}: endpoint out of range")
        if not _is_int(c):
            _fail(f"constraint {uid!r}: bound c must be an integer")
        if not isinstance(uid, str) or not uid:
            _fail(f"constraint {pos}: uid must be a non-empty string")
        if uid in base_edges or uid.startswith("ord:"):
            _fail(f"duplicate or reserved uid {uid!r}")
        base_edges[uid] = (u, v, c)
    disjuncts = []
    seen = set()
    for pos, pair in enumerate(inst.get("disjuncts", [])):
        if (not isinstance(pair, list) or len(pair) != 2
                or not all(_is_int(t) for t in pair)):
            _fail(f"disjunct {pos} must be a pair of task indices")
        i, j = pair
        if not (0 <= i < n) or not (0 <= j < n) or i == j:
            _fail(f"disjunct {pair}: invalid task indices")
        key = frozenset((i, j))
        if key in seen:
            _fail(f"duplicate disjunct {pair}")
        seen.add(key)
        disjuncts.append((i, j))
    return n, durations, base_edges, disjuncts


def _ordering_edge(durations, i, j, alt):
    first, second = (i, j) if alt == 0 else (j, i)
    return second, first, -durations[first], f"ord:{first}:{second}"


# ------------------------------------------------------------------ schedule

def verify_schedule(inst, schedule):
    """Check a claimed satisfying timetable.  Returns True or raises
    CheckFailure with the reason."""
    n, durations, base_edges, disjuncts = validate_instance(inst)
    if not isinstance(schedule, dict):
        _fail("schedule must be an object mapping task index to start time")
    if set(schedule.keys()) != {str(t) for t in range(n)}:
        _fail("schedule must assign exactly every task")
    starts = {}
    for key, value in schedule.items():
        if not _is_int(value):
            _fail(f"start time for task {key} is not an integer")
        starts[int(key)] = value
    for uid, (u, v, c) in base_edges.items():
        if starts[v] - starts[u] > c:
            _fail(f"constraint {uid!r} violated: "
                  f"x{v}-x{u} = {starts[v]-starts[u]} > {c}")
    for i, j in disjuncts:
        if not (starts[i] + durations[i] <= starts[j]
                or starts[j] + durations[j] <= starts[i]):
            _fail(f"disjunct ({i},{j}) violated: intervals overlap")
    return True


# -------------------------------------------------------------- conflict tree

def _verify_cycle(edges_ctx, cert):
    if not isinstance(cert, dict) or cert.get("type") != "negative_cycle":
        _fail("leaf certificate must be a negative_cycle object")
    edges = cert.get("edges")
    if not isinstance(edges, list) or not edges:
        _fail("cycle certificate must list at least one edge")
    total = 0
    prev_head = None
    first_tail = None
    for pos, edge in enumerate(edges):
        if not isinstance(edge, dict):
            _fail(f"cycle edge {pos} must be an object")
        uid, u, v, c = edge.get("uid"), edge.get("u"), edge.get("v"), edge.get("c")
        if uid not in edges_ctx:
            _fail(f"cycle edge {pos}: uid {uid!r} is not a base constraint "
                  "nor a decision on this branch path")
        eu, ev, ec = edges_ctx[uid]
        if (u, v, c) != (eu, ev, ec):
            _fail(f"cycle edge {pos}: ({u},{v},{c}) does not match the "
                  f"constraint recorded under uid {uid!r}")
        if prev_head is not None and u != prev_head:
            _fail(f"cycle edge {pos} does not connect to the previous edge")
        if first_tail is None:
            first_tail = u
        prev_head = v
        total += c
    if prev_head != first_tail:
        _fail("cycle edges do not form a closed cycle")
    if total >= 0:
        _fail(f"cycle weight {total} is not negative")
    if cert.get("weight") != total:
        _fail(f"declared weight {cert.get('weight')} != actual weight {total}")
    return True


def _replay_tree(node, durations, base_edges, disjunct_set, decisions):
    if not isinstance(node, dict):
        _fail("conflict tree node must be an object")
    ntype = node.get("type")
    if ntype == "leaf":
        ctx = dict(base_edges)
        ctx.update(decisions)
        return _verify_cycle(ctx, node.get("cycle"))
    if ntype != "node":
        _fail(f"unknown conflict tree node type {ntype!r}")
    pair = node.get("pair")
    if (not isinstance(pair, list) or len(pair) != 2
            or not all(_is_int(t) for t in pair)):
        _fail("branch node must carry a pair of task indices")
    i, j = pair
    if frozenset((i, j)) not in disjunct_set:
        _fail(f"branch node pair {pair} is not a disjunct of the instance")
    children = node.get("children")
    if not isinstance(children, dict):
        _fail("branch node must have a children object")
    if set(children.keys()) != {"0", "1"}:
        _fail("branch node must cover BOTH orderings (children '0' and '1'); "
              "an incomplete tree proves nothing")
    for alt in (0, 1):
        u, v, c, uid = _ordering_edge(durations, i, j, alt)
        child_decisions = dict(decisions)
        child_decisions[uid] = (u, v, c)
        _replay_tree(children[str(alt)], durations, base_edges,
                     disjunct_set, child_decisions)
    return True


def verify_conflict_tree(inst, tree):
    """Replay a claimed UNSAT branch tree.  Every root-to-leaf path adds the
    recorded ordering decisions; every leaf must exhibit a genuine negative
    cycle; every branch node must cover both orderings."""
    _, durations, base_edges, disjuncts = validate_instance(inst)
    disjunct_set = {frozenset(p) for p in disjuncts}
    return _replay_tree(tree, durations, base_edges, disjunct_set, {})


# ------------------------------------------------------------------ frontier

def verify_candidate(inst, candidate, frontier):
    """Check an UNKNOWN result: the candidate must satisfy the base
    constraints plus the ordering decisions chosen along the frontier --
    and nothing more is claimed."""
    n, durations, base_edges, disjuncts = validate_instance(inst)
    if not isinstance(frontier, dict) or not isinstance(frontier.get("choices"), list):
        _fail("frontier must be an object with a choices list")
    if not isinstance(candidate, dict):
        _fail("candidate must be an object mapping task index to start")
    if set(candidate.keys()) != {str(t) for t in range(n)}:
        _fail("candidate must assign exactly every task")
    starts = {}
    for key, value in candidate.items():
        if not _is_int(value):
            _fail(f"candidate start for task {key} is not an integer")
        starts[int(key)] = value
    edges = list(base_edges.items())  # (uid, (u, v, c))
    used = set()
    for pos, choice in enumerate(frontier["choices"]):
        if not isinstance(choice, dict):
            _fail(f"frontier choice {pos} must be an object")
        index, chosen = choice.get("index"), choice.get("chosen")
        if not _is_int(index) or not (0 <= index < len(disjuncts)):
            _fail(f"frontier choice {pos}: bad disjunct index")
        if index in used:
            _fail(f"frontier choice {pos}: disjunct {index} branched twice")
        used.add(index)
        if chosen not in (0, 1):
            _fail(f"frontier choice {pos}: chosen alternative must be 0 or 1")
        i, j = disjuncts[index]
        pair = choice.get("pair")
        if pair != [i, j] and pair != [j, i]:
            _fail(f"frontier choice {pos}: pair does not match the disjunct")
        u, v, c, uid = _ordering_edge(durations, i, j, chosen)
        edges.append((uid, (u, v, c)))
    for uid, (u, v, c) in edges:
        if starts[v] - starts[u] > c:
            _fail(f"candidate violates asserted constraint {uid!r}")
    return True


# ------------------------------------------------------------------ dispatch

def verify_result(inst, result):
    """Verify a full solver result object against the instance."""
    if not isinstance(result, dict):
        _fail("result must be an object")
    status = result.get("status")
    if status == "sat":
        return verify_schedule(inst, result.get("schedule"))
    if status == "unsat":
        return verify_conflict_tree(inst, result.get("conflict_tree"))
    if status == "unknown":
        return verify_candidate(inst, result.get("candidate"),
                                result.get("frontier"))
    _fail(f"unknown status {status!r}")


def check(inst, result):
    """Boolean wrapper: returns (ok, reason_or_None)."""
    try:
        verify_result(inst, result)
        return True, None
    except CheckFailure as exc:
        return False, str(exc)
