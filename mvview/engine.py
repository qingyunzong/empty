"""Incremental maintenance of a bag-semantics equi-join + group-by view.

Left table:  L(txn_id UNIQUE, cid, value)      -- transactions
Right table: R(cid, grp) with multiplicity     -- customer -> group (bag)

View per group: COUNT(*), SUM(value) ignoring NULLs, exact rational median,
and rank queries backed by a deletable order-statistics tree.

Batches are maintained with delta join rules including the cross term
dL x dR when both tables change in the same batch. A batch is validated in
full before any mutation, so illegal batches (out-of-range deletes, unique
id conflicts) leave tables, indexes, order statistics and the output cursor
untouched.
"""

from __future__ import annotations

from fractions import Fraction

from .orderstats import OrderStats


class BatchError(Exception):
    """Raised when a batch fails validation; nothing is applied."""


def to_fraction(value):
    if value is None or isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise BatchError(f"invalid value: {value!r}")
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, float):
        return Fraction(str(value))
    if isinstance(value, str):
        try:
            return Fraction(value)
        except (ValueError, ZeroDivisionError) as exc:
            raise BatchError(f"invalid value: {value!r}") from exc
    raise BatchError(f"invalid value: {value!r}")


def frac_to_json(value):
    if value is None:
        return None
    if value.denominator == 1:
        return value.numerator
    return f"{value.numerator}/{value.denominator}"


class GroupView:
    __slots__ = ("count", "sum", "stats")

    def __init__(self):
        self.count = 0
        self.sum = Fraction(0)
        self.stats = OrderStats()

    def median(self):
        n = len(self.stats)
        if n == 0:
            return None
        if n % 2 == 1:
            return self.stats.select(n // 2)
        return (self.stats.select(n // 2 - 1) + self.stats.select(n // 2)) / 2

    def snapshot(self):
        return {
            "count": self.count,
            "sum": frac_to_json(self.sum) if self.stats else None,
            "median": frac_to_json(self.median()),
        }


class Engine:
    def __init__(self, storage=None):
        self.left = {}            # txn_id -> (cid, Fraction|None)
        self.right = {}           # (cid, grp) -> multiplicity
        self.left_by_cid = {}     # cid -> {txn_id: value}
        self.right_by_cid = {}    # cid -> {grp: multiplicity}
        self.groups = {}          # grp -> GroupView
        self.outputs = []         # published per-batch view deltas (output cursor)
        self.batch_id = 0
        self.storage = storage

    # ------------------------------------------------------------------ #
    # batch normalization + validation (no mutation happens here)
    # ------------------------------------------------------------------ #
    def _normalize(self, batch):
        if not isinstance(batch, dict):
            raise BatchError("batch must be an object")
        dleft = []   # (cid, value, mult)
        dright = []  # (cid, grp, mult)

        li = list(batch.get("left_insert") or [])
        lr = list(batch.get("left_retract") or [])
        lp = list(batch.get("left_replace") or [])
        ri = list(batch.get("right_insert") or [])
        rr = list(batch.get("right_retract") or [])
        mg = list(batch.get("migrate") or [])

        insert_ids = set()
        for row in li:
            tid = row.get("id")
            if tid in insert_ids:
                raise BatchError(f"duplicate id in batch inserts: {tid!r}")
            if tid in self.left:
                raise BatchError(f"unique id conflict: {tid!r} already exists")
            insert_ids.add(tid)
            dleft.append((row.get("cid"), to_fraction(row.get("value")), +1))

        retract_ids = set()
        for item in lr:
            tid = item.get("id") if isinstance(item, dict) else item
            if tid in retract_ids:
                raise BatchError(f"duplicate retract of id: {tid!r}")
            if tid not in self.left:
                raise BatchError(f"out-of-range delete: id {tid!r} does not exist")
            if tid in insert_ids:
                raise BatchError(f"id {tid!r} both inserted and retracted in batch")
            retract_ids.add(tid)
            cid, value = self.left[tid]
            dleft.append((cid, value, -1))

        replace_ids = set()
        for row in lp:
            tid = row.get("id")
            if tid in replace_ids:
                raise BatchError(f"duplicate replace of id: {tid!r}")
            if tid not in self.left:
                raise BatchError(f"out-of-range replace: id {tid!r} does not exist")
            if tid in insert_ids or tid in retract_ids:
                raise BatchError(f"id {tid!r} has conflicting ops in batch")
            replace_ids.add(tid)
            cid, value = self.left[tid]
            dleft.append((cid, value, -1))
            dleft.append((row.get("cid"), to_fraction(row.get("value")), +1))

        net_right = {}

        def add_right(cid, grp, mult):
            key = (cid, grp)
            net_right[key] = net_right.get(key, 0) + mult

        for row in ri:
            count = row.get("count", 1)
            if not isinstance(count, int) or isinstance(count, bool) or count < 1:
                raise BatchError(f"invalid right insert count: {count!r}")
            add_right(row.get("cid"), row.get("group"), +count)

        for row in rr:
            count = row.get("count", 1)
            if not isinstance(count, int) or isinstance(count, bool) or count < 1:
                raise BatchError(f"invalid right retract count: {count!r}")
            add_right(row.get("cid"), row.get("group"), -count)

        for row in mg:
            count = row.get("count", 1)
            if not isinstance(count, int) or isinstance(count, bool) or count < 1:
                raise BatchError(f"invalid migrate count: {count!r}")
            src, dst = row.get("from"), row.get("to")
            if src == dst:
                raise BatchError("migrate source and target groups must differ")
            add_right(row.get("cid"), src, -count)
            add_right(row.get("cid"), dst, +count)

        for (cid, grp), mult in net_right.items():
            if mult == 0:
                continue
            if mult < 0 and self.right.get((cid, grp), 0) < -mult:
                raise BatchError(
                    f"out-of-range delete: right row {(cid, grp)!r} "
                    f"multiplicity {self.right.get((cid, grp), 0)} < {-mult}"
                )
            dright.append((cid, grp, mult))

        return dleft, dright

    # ------------------------------------------------------------------ #
    # commit
    # ------------------------------------------------------------------ #
    def apply_batch(self, batch, _replay=False):
        dleft, dright = self._normalize(batch)

        if self.storage is not None and not _replay:
            self.storage.log_batch(self.batch_id + 1, batch)

        # delta join: dL x R_old  +  L_old x dR  +  dL x dR (cross term)
        contrib = {}  # grp -> [count_delta, sum_delta, {value: mult}]

        def add(grp, mult, value):
            if mult == 0:
                return
            entry = contrib.setdefault(grp, [0, Fraction(0), {}])
            entry[0] += mult
            if value is not None:
                entry[1] += mult * value
                entry[2][value] = entry[2].get(value, 0) + mult

        for cid, value, mult in dleft:
            if cid is None:
                continue
            for grp, rmult in self.right_by_cid.get(cid, {}).items():
                add(grp, mult * rmult, value)

        for cid, grp, mult in dright:
            if cid is None:
                continue
            for value in self.left_by_cid.get(cid, {}).values():
                add(grp, mult, value)

        for cid, value, lmult in dleft:
            if cid is None:
                continue
            for rcid, grp, rmult in dright:
                if rcid == cid:
                    add(grp, lmult * rmult, value)

        # mutate base tables + indexes
        for row in batch.get("left_retract") or []:
            tid = row.get("id") if isinstance(row, dict) else row
            self._left_delete(tid)
        for row in batch.get("left_replace") or []:
            self._left_delete(row.get("id"))
        for row in batch.get("left_insert") or []:
            self._left_insert(row.get("id"), row.get("cid"), to_fraction(row.get("value")))
        for row in batch.get("left_replace") or []:
            self._left_insert(row.get("id"), row.get("cid"), to_fraction(row.get("value")))
        for cid, grp, mult in dright:
            self._right_add(cid, grp, mult)

        # mutate group views
        for grp, (cdelta, sdelta, vmults) in contrib.items():
            view = self.groups.setdefault(grp, GroupView())
            view.count += cdelta
            view.sum += sdelta
            for value, mult in vmults.items():
                if mult > 0:
                    view.stats.insert(value, mult)
                elif mult < 0:
                    view.stats.delete(value, -mult)
            if view.count == 0:
                if len(view.stats) != 0 or view.sum != 0:
                    raise AssertionError("inconsistent empty group view")
                del self.groups[grp]

        self.batch_id += 1
        record = {
            "batch_id": self.batch_id,
            "groups": {
                grp: {"count_delta": c, "sum_delta": frac_to_json(s)}
                for grp, (c, s, _v) in sorted(contrib.items(), key=lambda kv: str(kv[0]))
            },
        }
        self.outputs.append(record)
        if self.storage is not None and not _replay:
            self.storage.log_commit(self.batch_id)
        return record

    # ------------------------------------------------------------------ #
    # base-table mutation helpers (only called after full validation)
    # ------------------------------------------------------------------ #
    def _left_insert(self, tid, cid, value):
        self.left[tid] = (cid, value)
        self.left_by_cid.setdefault(cid, {})[tid] = value

    def _left_delete(self, tid):
        cid, _value = self.left.pop(tid)
        bucket = self.left_by_cid[cid]
        del bucket[tid]
        if not bucket:
            del self.left_by_cid[cid]

    def _right_add(self, cid, grp, mult):
        key = (cid, grp)
        new = self.right.get(key, 0) + mult
        if new == 0:
            self.right.pop(key, None)
            bucket = self.right_by_cid.get(cid)
            if bucket is not None:
                bucket.pop(grp, None)
                if not bucket:
                    del self.right_by_cid[cid]
        else:
            self.right[key] = new
            self.right_by_cid.setdefault(cid, {})[grp] = new

    # ------------------------------------------------------------------ #
    # queries
    # ------------------------------------------------------------------ #
    def view(self):
        return {grp: self.groups[grp].snapshot() for grp in sorted(self.groups, key=str)}

    def rank(self, grp, value):
        view = self.groups.get(grp)
        if view is None:
            return 0
        return view.stats.rank(to_fraction(value))

    def median(self, grp):
        view = self.groups.get(grp)
        if view is None:
            return None
        return frac_to_json(view.median())

    # ------------------------------------------------------------------ #
    # recovery
    # ------------------------------------------------------------------ #
    def rebuild_views(self):
        """Recompute group views from base tables (used after loading a
        checkpoint; per-batch maintenance stays incremental)."""
        self.groups = {}
        self.left_by_cid = {}
        self.right_by_cid = {}
        for tid, (cid, value) in self.left.items():
            self.left_by_cid.setdefault(cid, {})[tid] = value
        for (cid, grp), mult in self.right.items():
            self.right_by_cid.setdefault(cid, {})[grp] = mult
        for (cid, grp), rmult in self.right.items():
            if cid is None:
                continue
            for value in self.left_by_cid.get(cid, {}).values():
                view = self.groups.setdefault(grp, GroupView())
                view.count += rmult
                if value is not None:
                    view.sum += rmult * value
                    view.stats.insert(value, rmult)
        for grp in [g for g, v in self.groups.items() if v.count == 0]:
            del self.groups[grp]
