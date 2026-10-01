"""Actual execution of the chosen plan under the row residency budget.

Residency discipline: an operator buffer (BNLJ block, GHJ build table,
in-memory intermediate) never holds more than ``budget`` rows.  Anything
larger is spilled to temporary JSONL files; Grace hash join partitions
recursively until each build partition fits.  All temporary files live in
one TemporaryDirectory that is removed when the run finishes.
"""

import hashlib
import json
import os
import tempfile
from math import ceil

from .jsonutil import canonical
from .planner import NLJ, BNLJ, GHJ, plan_query

MAX_PARTITION_FANOUT = 256


class Stats:
    def __init__(self):
        self.rows_read = 0
        self.partitions_created = 0
        self.temp_files_created = 0
        self.spilled_intermediates = 0
        self.recursive_partition_calls = 0
        self.bnlj_fallbacks = 0

    def as_dict(self):
        return dict(self.__dict__)


# ---------------------------------------------------------------- sources

class Source:
    size = 0

    def scan(self, stats):
        raise NotImplementedError


class TableSource(Source):
    """A base table; conceptually external storage, streamed row by row."""

    def __init__(self, table, rows):
        self.table = table
        self.rows = rows
        self.size = len(rows)

    def scan(self, stats):
        prefix = self.table + "."
        for row in self.rows:
            stats.rows_read += 1
            yield {prefix + k: v for k, v in row.items()}


class MemorySource(Source):
    """An intermediate result small enough (<= budget) to stay resident."""

    def __init__(self, rows):
        self.rows = rows
        self.size = len(rows)

    def scan(self, stats):
        for row in self.rows:
            stats.rows_read += 1
            yield row


class FileSource(Source):
    """A spilled intermediate or partition, streamed from a temp file."""

    def __init__(self, path, size):
        self.path = path
        self.size = size

    def scan(self, stats):
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                stats.rows_read += 1
                yield json.loads(line)


def _new_temp_file(tmpdir, stats, prefix):
    fd, path = tempfile.mkstemp(dir=tmpdir, prefix=prefix, suffix=".jsonl")
    stats.temp_files_created += 1
    return os.fdopen(fd, "w", encoding="utf-8"), path


def collect(gen, budget, tmpdir, stats):
    """Materialize a join output, spilling to a temp file beyond `budget`."""
    buf = []
    fh = None
    path = None
    count = 0
    for row in gen:
        count += 1
        if fh is None and len(buf) < budget:
            buf.append(row)
            continue
        if fh is None:
            fh, path = _new_temp_file(tmpdir, stats, "spill-")
            stats.spilled_intermediates += 1
            for b in buf:
                fh.write(canonical(b) + "\n")
            buf = []
        fh.write(canonical(row) + "\n")
    if fh is not None:
        fh.close()
        return FileSource(path, count)
    return MemorySource(buf)


# ---------------------------------------------------------------- join keys

def make_keyfn(attrs):
    def keyfn(row):
        vals = []
        for a in attrs:
            v = row.get(a)
            if v is None:  # NULL keys never match
                return None
            vals.append(canonical(v))
        return tuple(vals)
    return keyfn


def _bucket(key, nparts):
    digest = hashlib.sha256(canonical(list(key)).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % nparts


# ---------------------------------------------------------------- algorithms

def nlj_gen(left, right, lkey, rkey, stats):
    for l in left.scan(stats):
        lk = lkey(l)
        if lk is None:
            continue
        for r in right.scan(stats):
            if lk == rkey(r):
                yield {**l, **r}


def bnlj_gen(outer, inner, okey, ikey, stats, budget):
    block_size = max(1, min(budget, outer.size))
    block = []

    def process():
        for i in inner.scan(stats):
            ik = ikey(i)
            if ik is None:
                continue
            for o in block:
                if okey(o) == ik:
                    yield {**o, **i}

    for o in outer.scan(stats):
        block.append(o)
        if len(block) >= block_size:
            yield from process()
            block = []
    if block:
        yield from process()


def ghj_gen(build, probe, bkey, pkey, stats, budget, tmpdir):
    if build.size <= budget:
        table = {}
        for b in build.scan(stats):
            k = bkey(b)
            if k is not None:
                table.setdefault(k, []).append(b)
        for p in probe.scan(stats):
            k = pkey(p)
            if k is None:
                continue
            for b in table.get(k, ()):
                yield {**b, **p}
        return

    # Build side exceeds the budget: recursively partition to temp files.
    nparts = min(max(2, ceil(build.size / budget)), MAX_PARTITION_FANOUT)
    build_files, probe_files = [], []
    build_paths, probe_paths = [], []
    for _ in range(nparts):
        fh, path = _new_temp_file(tmpdir, stats, "ghj-build-")
        build_files.append(fh)
        build_paths.append(path)
        fh, path = _new_temp_file(tmpdir, stats, "ghj-probe-")
        probe_files.append(fh)
        probe_paths.append(path)
    stats.partitions_created += 2 * nparts

    build_counts = [0] * nparts
    probe_counts = [0] * nparts
    for b in build.scan(stats):
        k = bkey(b)
        if k is None:
            continue
        i = _bucket(k, nparts)
        build_files[i].write(canonical(b) + "\n")
        build_counts[i] += 1
    for p in probe.scan(stats):
        k = pkey(p)
        if k is None:
            continue
        i = _bucket(k, nparts)
        probe_files[i].write(canonical(p) + "\n")
        probe_counts[i] += 1
    for fh in build_files + probe_files:
        fh.close()

    for i in range(nparts):
        bsrc = FileSource(build_paths[i], build_counts[i])
        psrc = FileSource(probe_paths[i], probe_counts[i])
        if bsrc.size > budget and bsrc.size == build.size:
            # Skew: partitioning made no progress (e.g. all keys equal).
            stats.bnlj_fallbacks += 1
            yield from bnlj_gen(bsrc, psrc, bkey, pkey, stats, budget)
        else:
            if bsrc.size > budget:
                stats.recursive_partition_calls += 1
            yield from ghj_gen(bsrc, psrc, bkey, pkey, stats, budget, tmpdir)


# ---------------------------------------------------------------- driver

def execute_plan(plan, data, budget, tmpdir, stats):
    left = TableSource(plan.order[0], data[plan.order[0]])
    for step in plan.steps:
        right = TableSource(step["table"], data[step["table"]])
        lkey = make_keyfn(step["left_key_attrs"])
        rkey = make_keyfn(step["right_key_attrs"])
        algo = step["algorithm"]
        if algo == NLJ:
            gen = nlj_gen(left, right, lkey, rkey, stats)
        elif algo == BNLJ:
            if step.get("outer") == "right":
                gen = bnlj_gen(right, left, rkey, lkey, stats, budget)
            else:
                gen = bnlj_gen(left, right, lkey, rkey, stats, budget)
        elif algo == GHJ:
            if step.get("build_side") == "right":
                gen = ghj_gen(right, left, rkey, lkey, stats, budget, tmpdir)
            else:
                gen = ghj_gen(left, right, lkey, rkey, stats, budget, tmpdir)
        else:
            raise ValueError("unknown algorithm: {}".format(algo))
        left = collect(gen, budget, tmpdir, stats)
    return left


def run_query(tables, edges, data, budget):
    """Plan, execute, dedup/sort, and return rows plus the plan trace."""
    plan, trace = plan_query(tables, edges, data, budget)
    stats = Stats()
    tmpdir = tempfile.mkdtemp(prefix="memjoin-")
    try:
        final = execute_plan(plan, data, budget, tmpdir, stats)
        seen = {}
        for row in final.scan(stats):
            seen[canonical(row)] = row
        rows = [seen[k] for k in sorted(seen)]
    finally:
        cleaned = 0
        for name in os.listdir(tmpdir):
            os.remove(os.path.join(tmpdir, name))
            cleaned += 1
        os.rmdir(tmpdir)
    trace["execution"] = {
        **stats.as_dict(),
        "temp_files_cleaned": cleaned,
        "temp_dir_removed": not os.path.exists(tmpdir),
        "result_rows": len(rows),
    }
    return {"rows": rows, "plan_trace": trace}
