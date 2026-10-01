"""Memory-constrained equi-join planning and execution.

Supports inner equi-joins over 2 to 4 tables under a row-residency budget M.

Algorithms
----------
- nested_loop:       one outer row at a time, full inner scan per outer row.
- block_nested_loop: outer is read in blocks of at most M rows; the inner
                     input is scanned once per block.
- grace_hash:        in-memory hash join when the build side fits in M rows;
                     otherwise both sides are recursively hash-partitioned to
                     temporary files (cleaned up afterwards).  If a partition
                     cannot be shrunk by hashing (extreme skew), the pair
                     falls back to block nested loop so execution always
                     terminates within the budget.

Semantics
---------
- NULL (JSON null) join keys never match.
- The result uses set semantics: duplicate rows are removed and the rows are
  sorted by their canonical JSON encoding.
- "rows read" counts every row scanned from a base table or from a temporary
  partition file; in-memory intermediate results are scanned for free.

Planning
--------
All left-deep orders whose prefixes stay connected through the join graph are
enumerated (falling back to every permutation for disconnected graphs).  For
each join step the cheapest algorithm is picked; plans are ordered by
(estimated rows read, algorithm names, table order), all ascending
lexicographically, so ties break on algorithm name and then table order.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import shutil
import tempfile
from dataclasses import dataclass

ALGO_NLJ = "nested_loop"
ALGO_BNLJ = "block_nested_loop"
ALGO_GHJ = "grace_hash"


class QueryError(Exception):
    """Raised for invalid query or data descriptions."""


def canonical(row):
    """Deterministic string encoding of a row (used for dedupe/sort/hashing)."""
    return json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

def validate_query(obj):
    if not isinstance(obj, dict):
        raise QueryError("query must be a JSON object")
    tables = obj.get("tables")
    joins = obj.get("joins", [])
    if not isinstance(tables, list) or not all(isinstance(t, str) for t in tables):
        raise QueryError("query.tables must be a list of table names")
    if len(set(tables)) != len(tables):
        raise QueryError("query.tables must not contain duplicates")
    if not 2 <= len(tables) <= 4:
        raise QueryError("query must involve 2 to 4 tables")
    if not isinstance(joins, list):
        raise QueryError("query.joins must be a list")
    norm_joins = []
    for j in joins:
        try:
            left, lkey = j["left"], j["left_key"]
            right, rkey = j["right"], j["right_key"]
        except (TypeError, KeyError):
            raise QueryError("each join needs left/left_key/right/right_key")
        if left not in tables or right not in tables:
            raise QueryError(f"join references unknown table: {j!r}")
        if left == right:
            raise QueryError(f"self joins are not supported: {j!r}")
        if not isinstance(lkey, str) or not isinstance(rkey, str):
            raise QueryError("join keys must be column names (strings)")
        norm_joins.append(
            {"left": left, "left_key": lkey, "right": right, "right_key": rkey}
        )
    return {"tables": list(tables), "joins": norm_joins}


def validate_data(obj, tables):
    if not isinstance(obj, dict):
        raise QueryError("data must be a JSON object mapping table -> rows")
    data = {}
    for t in tables:
        rows = obj.get(t)
        if rows is None:
            raise QueryError(f"data is missing table {t!r}")
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise QueryError(f"data[{t!r}] must be a list of row objects")
        data[t] = rows
    return data


def build_stats(data):
    stats = {}
    for table, rows in data.items():
        distinct = {}
        for row in rows:
            for col, val in row.items():
                distinct.setdefault(col, set()).add(canonical(val))
        stats[table] = {
            "rows": len(rows),
            "distinct": {c: len(v) for c, v in distinct.items()},
        }
    return stats


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------

@dataclass
class StepPlan:
    algorithm: str
    outer_tables: tuple
    inner_table: str
    conditions: list  # list of (left_key, right_key); left refers to outer side
    est_rows_read: int
    est_output_rows: int


@dataclass
class Plan:
    order: tuple
    steps: list
    est_rows_read: int


def _connected_orders(tables, joins):
    adj = {t: set() for t in tables}
    for j in joins:
        adj[j["left"]].add(j["right"])
        adj[j["right"]].add(j["left"])
    connected = []
    for perm in itertools.permutations(tables):
        if all(
            any(perm[j] in adj[perm[i]] for j in range(i))
            for i in range(1, len(perm))
        ):
            connected.append(perm)
    if connected:
        return connected
    return list(itertools.permutations(tables))


def _estimate_card(cur_card, t_card, conds, cur_tables, t, stats):
    est = float(cur_card) * float(t_card)
    for lk, rk in conds:
        vl = max((stats[s]["distinct"].get(lk, 0) for s in cur_tables), default=0)
        vr = stats[t]["distinct"].get(rk, 0)
        est /= max(vl, vr, 1)
    return int(math.ceil(est))


def _plan_order(order, joins, stats, budget):
    steps = []
    cur_tables = (order[0],)
    cur_card = stats[order[0]]["rows"]
    total = 0
    for t in order[1:]:
        conds = [
            (j["left_key"], j["right_key"])
            for j in joins
            if j["left"] in cur_tables and j["right"] == t
        ] + [
            (j["right_key"], j["left_key"])
            for j in joins
            if j["right"] in cur_tables and j["left"] == t
        ]
        t_card = stats[t]["rows"]
        outer_reads = cur_card if len(cur_tables) == 1 else 0
        cands = {
            ALGO_NLJ: outer_reads + cur_card * t_card,
            ALGO_BNLJ: outer_reads + math.ceil(cur_card / budget) * t_card
            if cur_card
            else 0,
        }
        if conds:
            ghj = outer_reads + t_card
            if min(cur_card, t_card) > budget:
                # partitioning pass: every row is read back from temp files
                ghj += cur_card + t_card
            cands[ALGO_GHJ] = ghj
        algo, cost = min(cands.items(), key=lambda kv: (kv[1], kv[0]))
        out_card = _estimate_card(cur_card, t_card, conds, cur_tables, t, stats)
        steps.append(StepPlan(algo, cur_tables, t, conds, cost, out_card))
        total += cost
        cur_tables = cur_tables + (t,)
        cur_card = out_card
    return Plan(order, steps, total)


def plan_join(query, stats, budget):
    best = None
    for order in _connected_orders(query["tables"], query["joins"]):
        plan = _plan_order(order, query["joins"], stats, budget)
        key = (
            plan.est_rows_read,
            tuple(s.algorithm for s in plan.steps),
            plan.order,
        )
        if best is None or key < best[0]:
            best = (key, plan)
    return best[1]


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

class Source:
    card = 0

    def scan(self):
        raise NotImplementedError


class TableSource(Source):
    """A base table; scanning counts as rows read."""

    def __init__(self, ex, table):
        self.ex = ex
        self.table = table
        self.card = len(ex.data[table])

    def scan(self):
        for row in self.ex.data[self.table]:
            self.ex.rows_read += 1
            yield row


class MemSource(Source):
    """An in-memory intermediate result; scanning is free."""

    def __init__(self, rows):
        self.rows = rows
        self.card = len(rows)

    def scan(self):
        return iter(self.rows)


class FileSource(Source):
    """A temporary partition file; scanning counts as rows read."""

    def __init__(self, ex, path, card):
        self.ex = ex
        self.path = path
        self.card = card

    def scan(self):
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                self.ex.rows_read += 1
                yield json.loads(line)


class Executor:
    def __init__(self, data, budget):
        if not isinstance(budget, int) or budget < 1:
            raise QueryError("budget must be a positive integer")
        self.data = data
        self.budget = budget
        self.rows_read = 0
        self.partition_fanouts = []
        self._tmpdirs = []

    def cleanup(self):
        for d in self._tmpdirs:
            shutil.rmtree(d, ignore_errors=True)
        self._tmpdirs.clear()

    # -- predicates ---------------------------------------------------------

    @staticmethod
    def _matches(lrow, rrow, conditions):
        for lk, rk in conditions:
            lv = lrow.get(lk)
            rv = rrow.get(rk)
            if lv is None or rv is None or lv != rv:
                return False
        return True

    @staticmethod
    def _keyof(row, keys):
        return tuple(row.get(k) for k in keys)

    @staticmethod
    def _key_ok(key):
        return all(v is not None for v in key)

    # -- nested loop ---------------------------------------------------------

    def nlj(self, outer, inner, conditions):
        for orow in outer.scan():
            for irow in inner.scan():
                if self._matches(orow, irow, conditions):
                    yield {**orow, **irow}

    # -- block nested loop ---------------------------------------------------

    def bnlj(self, outer, inner, conditions):
        block = []
        for orow in outer.scan():
            block.append(orow)
            if len(block) >= self.budget:
                yield from self._bnlj_block(block, inner, conditions)
                block.clear()
        if block:
            yield from self._bnlj_block(block, inner, conditions)

    def _bnlj_block(self, block, inner, conditions):
        assert len(block) <= self.budget
        for irow in inner.scan():
            for orow in block:
                if self._matches(orow, irow, conditions):
                    yield {**orow, **irow}

    # -- grace hash join -----------------------------------------------------

    def ghj(self, left, right, lkeys, rkeys):
        if left.card <= right.card:
            build, probe, bkeys, pkeys, build_left = (
                left, right, lkeys, rkeys, True,
            )
        else:
            build, probe, bkeys, pkeys, build_left = (
                right, left, rkeys, lkeys, False,
            )
        if build.card <= self.budget:
            return self._hash_join(build, probe, bkeys, pkeys, build_left)
        return self._partition_join(build, probe, bkeys, pkeys, build_left)

    def _hash_join(self, build, probe, bkeys, pkeys, build_left):
        table = {}
        resident = 0
        for row in build.scan():
            key = self._keyof(row, bkeys)
            if not self._key_ok(key):
                continue
            table.setdefault(canonical(list(key)), []).append(row)
            resident += 1
            assert resident <= self.budget, "hash build side exceeds budget"
        out = []
        for row in probe.scan():
            key = self._keyof(row, pkeys)
            if not self._key_ok(key):
                continue
            for brow in table.get(canonical(list(key)), ()):
                out.append({**brow, **row} if build_left else {**row, **brow})
        return out

    def _partition_join(self, build, probe, bkeys, pkeys, build_left):
        fanout = max(2, math.ceil(build.card / self.budget))
        tmp = tempfile.mkdtemp(prefix="memjoin-")
        self._tmpdirs.append(tmp)
        self.partition_fanouts.append(fanout)
        build_parts = self._partition(build, bkeys, fanout, tmp, "build")
        probe_parts = self._partition(probe, pkeys, fanout, tmp, "probe")
        out = []
        for bsrc, psrc in zip(build_parts, probe_parts):
            if bsrc.card == 0 or psrc.card == 0:
                continue
            if bsrc.card <= self.budget:
                out.extend(self._hash_join(bsrc, psrc, bkeys, pkeys, build_left))
            elif bsrc.card < build.card:
                # progress was made; partition the smaller pair recursively
                out.extend(
                    self._partition_join(bsrc, psrc, bkeys, pkeys, build_left)
                )
            else:
                # hashing cannot shrink this partition (extreme skew):
                # fall back to block nested loop, which always fits
                out.extend(
                    self._bnlj_sources(bsrc, psrc, bkeys, pkeys, build_left)
                )
        return out

    def _partition(self, src, keys, fanout, tmpdir, tag):
        paths = [os.path.join(tmpdir, f"{tag}-{i}.jsonl") for i in range(fanout)]
        files = [open(p, "w", encoding="utf-8") for p in paths]
        counts = [0] * fanout
        try:
            for row in src.scan():
                key = self._keyof(row, keys)
                if not self._key_ok(key):
                    continue  # NULL keys never match; drop early
                digest = hashlib.sha256(canonical(list(key)).encode("utf-8")).digest()
                h = int.from_bytes(digest[:8], "big") % fanout
                files[h].write(json.dumps(row) + "\n")
                counts[h] += 1
        finally:
            for f in files:
                f.close()
        return [FileSource(self, p, c) for p, c in zip(paths, counts)]

    def _bnlj_sources(self, outer, inner, okeys, ikeys, outer_is_left):
        out = []
        block = []
        for orow in outer.scan():
            block.append(orow)
            if len(block) >= self.budget:
                self._bnlj_flush(block, inner, okeys, ikeys, outer_is_left, out)
                block.clear()
        if block:
            self._bnlj_flush(block, inner, okeys, ikeys, outer_is_left, out)
        return out

    def _bnlj_flush(self, block, inner, okeys, ikeys, outer_is_left, out):
        assert len(block) <= self.budget
        for irow in inner.scan():
            ikey = self._keyof(irow, ikeys)
            if not self._key_ok(ikey):
                continue
            for orow in block:
                if self._keyof(orow, okeys) == ikey:
                    out.append({**orow, **irow} if outer_is_left else {**irow, **orow})


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def dedupe_sort(rows):
    uniq = {}
    for r in rows:
        uniq.setdefault(canonical(r), r)
    return [uniq[k] for k in sorted(uniq)]


def run_plan(ex, plan):
    cur = TableSource(ex, plan.order[0])
    trace = []
    for idx, step in enumerate(plan.steps, 1):
        ex.rows_read = 0
        ex.partition_fanouts = []
        right = TableSource(ex, step.inner_table)
        if step.algorithm == ALGO_NLJ:
            rows = list(ex.nlj(cur, right, step.conditions))
        elif step.algorithm == ALGO_BNLJ:
            rows = list(ex.bnlj(cur, right, step.conditions))
        else:
            lkeys = [c[0] for c in step.conditions]
            rkeys = [c[1] for c in step.conditions]
            rows = ex.ghj(cur, right, lkeys, rkeys)
        trace.append(
            {
                "step": idx,
                "algorithm": step.algorithm,
                "outer": list(step.outer_tables),
                "inner": step.inner_table,
                "conditions": [
                    {"left_key": lk, "right_key": rk} for lk, rk in step.conditions
                ],
                "estimated_rows_read": step.est_rows_read,
                "rows_read": ex.rows_read,
                "output_rows": len(rows),
                "partitions": sum(ex.partition_fanouts),
            }
        )
        cur = MemSource(rows)
    return dedupe_sort(cur.rows), trace


def run_query(query, data, budget):
    stats = build_stats(data)
    plan = plan_join(query, stats, budget)
    ex = Executor(data, budget)
    try:
        return run_plan(ex, plan)
    finally:
        ex.cleanup()
