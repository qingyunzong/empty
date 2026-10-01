"""Plan enumeration and cost-based selection.

Cost unit: rows read by join operators (base table scans, re-scans of
inner inputs, re-reads of spilled partitions).  Cardinalities of every
table subset are computed exactly (the data is available, so the
"statistics" are perfect) unless an intermediate would exceed
``MAX_EXACT_ROWS``, in which case a deterministic selectivity estimate
is used instead.
"""

from itertools import permutations, product
from math import ceil

from .jsonutil import canonical, qualify

NLJ = "nested_loop"
BNLJ = "block_nested_loop"
GHJ = "grace_hash"
ALGORITHMS = (NLJ, BNLJ, GHJ)

MAX_EXACT_ROWS = 1_000_000


class _TooLarge(Exception):
    pass


def _key_of(row, attrs):
    """Join key tuple of canonical encodings, or None if any part is NULL."""
    vals = []
    for a in attrs:
        v = row.get(a)
        if v is None:
            return None
        vals.append(canonical(v))
    return tuple(vals)


def _crossing_edges(edges, left_tables, right_table):
    """Edges between the accumulated left tables and the new right table."""
    out = []
    for lt, la, rt, ra in edges:
        if rt == right_table and lt in left_tables:
            out.append(("{}.{}".format(lt, la), ra))
        elif lt == right_table and rt in left_tables:
            out.append(("{}.{}".format(rt, ra), la))
    return out


class Cardinalities:
    """Exact (or estimated) row counts for joins of every table subset."""

    def __init__(self, tables, edges, data):
        self._edges = edges
        self._data = data
        self._sizes = {}
        self._rows = {}
        for t in tables:
            rows = [qualify(t, r) for r in data[t]]
            self._rows[frozenset((t,))] = rows
            self._sizes[frozenset((t,))] = len(rows)

    def size(self, subset):
        subset = frozenset(subset)
        if subset not in self._sizes:
            try:
                rows = self._materialize(subset)
                self._sizes[subset] = len(rows)
            except _TooLarge:
                self._sizes[subset] = self._estimate(subset)
        return self._sizes[subset]

    def _materialize(self, subset):
        pick = sorted(subset)[0]
        rest = subset - {pick}
        rest_rows = self._rows.get(rest)
        if rest_rows is None:
            self.size(rest)  # ensures `rest` is resolved one way or another
            rest_rows = self._rows.get(rest)
            if rest_rows is None:
                raise _TooLarge
        right_rows = self._rows[frozenset((pick,))]
        cross = _crossing_edges(self._edges, rest, pick)
        if not cross:
            if len(rest_rows) * len(right_rows) > MAX_EXACT_ROWS:
                raise _TooLarge
            result = [{**a, **b} for a in rest_rows for b in right_rows]
        else:
            left_attrs = [c[0] for c in cross]
            right_attrs = ["{}.{}".format(pick, c[1]) for c in cross]
            index = {}
            for r in right_rows:
                k = _key_of(r, right_attrs)
                if k is not None:
                    index.setdefault(k, []).append(r)
            result = []
            for l in rest_rows:
                k = _key_of(l, left_attrs)
                if k is None:
                    continue
                for r in index.get(k, ()):
                    result.append({**l, **r})
                    if len(result) > MAX_EXACT_ROWS:
                        raise _TooLarge
        self._rows[subset] = result
        return result

    def _estimate(self, subset):
        est = 1
        for t in subset:
            est *= len(self._data[t])
        for lt, la, rt, ra in self._edges:
            if lt in subset and rt in subset:
                distinct = max(
                    len({canonical(r.get(la)) for r in self._data[lt]}),
                    len({canonical(r.get(ra)) for r in self._data[rt]}),
                    1,
                )
                est //= distinct
        return est


def _bnlj_cost(outer, inner, budget):
    if outer == 0:
        return 0
    block = min(budget, outer)
    return outer + ceil(outer / block) * inner


def step_estimate(algo, left_size, right_size, budget):
    """Return (rows_read, detail) for one join step."""
    if algo == NLJ:
        return left_size + left_size * right_size, {"outer": "left"}
    if algo == BNLJ:
        cost_left = _bnlj_cost(left_size, right_size, budget)
        cost_right = _bnlj_cost(right_size, left_size, budget)
        if cost_right < cost_left:
            return cost_right, {"outer": "right",
                                "block_rows": min(budget, right_size)}
        return cost_left, {"outer": "left", "block_rows": min(budget, left_size)}
    if algo == GHJ:
        build = min(left_size, right_size)
        detail = {"build_side": "left" if left_size <= right_size else "right"}
        if build <= budget:
            detail["partition_levels"] = 0
            return left_size + right_size, detail
        detail["partition_levels"] = 1
        detail["partitions"] = max(2, ceil(build / budget))
        return 2 * (left_size + right_size), detail
    raise ValueError("unknown algorithm: {}".format(algo))


class Plan:
    def __init__(self, order, algorithms, cost, steps):
        self.order = tuple(order)
        self.algorithms = tuple(algorithms)
        self.cost = cost
        self.steps = steps

    def sort_key(self):
        # Fewest rows read wins; ties broken by algorithm names, then by
        # table order, both lexicographic.
        return (self.cost, self.algorithms, self.order)


def enumerate_plans(tables, edges, data, budget):
    card = Cardinalities(tables, edges, data)
    plans = []
    for order in permutations(tables):
        for algos in product(ALGORITHMS, repeat=len(tables) - 1):
            steps = []
            total = 0
            accum = frozenset((order[0],))
            left_size = card.size(accum)
            for i, algo in enumerate(algos):
                table = order[i + 1]
                right_size = card.size(frozenset((table,)))
                cost, detail = step_estimate(algo, left_size, right_size, budget)
                cross = _crossing_edges(edges, accum, table)
                accum = accum | {table}
                result_size = card.size(accum)
                steps.append({
                    "algorithm": algo,
                    "table": table,
                    "left_size": left_size,
                    "right_size": right_size,
                    "estimated_reads": cost,
                    "result_size": result_size,
                    "left_key_attrs": [c[0] for c in cross],
                    "right_key_attrs": ["{}.{}".format(table, c[1]) for c in cross],
                    **detail,
                })
                total += cost
                left_size = result_size
            plans.append(Plan(order, algos, total, steps))
    plans.sort(key=lambda p: p.sort_key())
    return plans


def plan_query(tables, edges, data, budget, top_k=5):
    """Select the best plan; return (chosen_plan, trace_dict)."""
    plans = enumerate_plans(tables, edges, data, budget)
    chosen = plans[0]
    trace = {
        "budget": budget,
        "candidates_considered": len(plans),
        "selection_rule": "min rows read, then algorithm names, then table order",
        "ranked_candidates": [
            {
                "rank": i + 1,
                "table_order": list(p.order),
                "algorithms": list(p.algorithms),
                "estimated_reads": p.cost,
            }
            for i, p in enumerate(plans[:top_k])
        ],
        "chosen": {
            "table_order": list(chosen.order),
            "algorithms": list(chosen.algorithms),
            "estimated_total_reads": chosen.cost,
            "steps": chosen.steps,
        },
    }
    return chosen, trace
