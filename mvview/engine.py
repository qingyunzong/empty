"""Incremental maintenance of an equi-join + GROUP BY materialized view.

Tables (both are bags):
  left  : txid -> (customer, value)        unique transaction id
  right : (customer, group) -> multiplicity

The view groups the natural join on `customer` by `group` and keeps, per
group, COUNT(*), the NULL-skipping SUM, and an exact rational median plus
rank/select over the non-NULL values.

Batch maintenance uses the standard delta-join rule including the
same-batch cross term:

    delta(L |x| R) = dL |x| R_old  +  L_old |x| dR  +  dL |x| dR

A batch is atomic: any constraint violation (unknown txid retract,
duplicate txid insert, over-retract of right rows, negative group count)
rolls the tables, the group statistics and the published version back to
the pre-batch state.  Committed batches are appended to a write-ahead log
as begin/commit record pairs; checkpoints snapshot the base tables.
Recovery loads the newest checkpoint and replays only committed batches
with a batch id greater than the checkpoint version, so committed batches
are never counted twice and an uncommitted or torn log tail is ignored.
"""

import json
import os

from .jsonnum import num_from_json, num_to_json
from .stats import GroupStats


class BatchError(Exception):
    """A batch violated a constraint; the engine state is left unchanged."""


def _canon_op(op):
    """Validate and normalize one user op into its JSON-canonical form."""
    if not isinstance(op, dict):
        raise BatchError(f"op must be an object, got {op!r}")
    kind = op.get("op")
    if kind in ("insert_tx", "replace_tx"):
        txid = op.get("txid")
        if txid is None:
            raise BatchError(f"{kind} requires a non-null txid")
        try:
            value = num_from_json(op.get("value"))
        except (ValueError, KeyError, TypeError, ZeroDivisionError) as exc:
            raise BatchError(f"invalid value in {kind}: {exc}") from exc
        return {"op": kind, "txid": txid, "customer": op.get("customer"),
                "value": num_to_json(value)}
    if kind == "retract_tx":
        txid = op.get("txid")
        if txid is None:
            raise BatchError("retract_tx requires a non-null txid")
        return {"op": kind, "txid": txid}
    if kind in ("insert_cust", "retract_cust"):
        count = op.get("count", 1)
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise BatchError(f"{kind} count must be a positive integer")
        return {"op": kind, "customer": op.get("customer"),
                "group": op.get("group"), "count": count}
    if kind == "migrate":
        count = op.get("count")
        if count is not None and (
                not isinstance(count, int) or isinstance(count, bool) or count < 1):
            raise BatchError("migrate count must be a positive integer or null")
        return {"op": kind, "customer": op.get("customer"),
                "from": op.get("from"), "to": op.get("to"), "count": count}
    raise BatchError(f"unknown op {kind!r}")


class Engine:
    """Maintains the join view; optionally bound to a state directory."""

    def __init__(self):
        self.left = {}
        self.right = {}
        self.groups = {}
        self.version = 0
        self._state_dir = None
        self._wal_path = None
        self._checkpoint_path = None

    # ---------------------------------------------------------- persistence

    @classmethod
    def open(cls, state_dir):
        """Open (or create) a persistent engine rooted at `state_dir`."""
        eng = cls()
        eng._state_dir = state_dir
        eng._wal_path = os.path.join(state_dir, "wal.log")
        eng._checkpoint_path = os.path.join(state_dir, "checkpoint.json")
        os.makedirs(state_dir, exist_ok=True)
        eng._recover()
        return eng

    def _recover(self):
        if os.path.exists(self._checkpoint_path):
            with open(self._checkpoint_path, encoding="utf-8") as fh:
                snap = json.load(fh)
            self.version = snap["version"]
            for row in snap["left"]:
                self.left[row["txid"]] = (row["customer"],
                                          num_from_json(row["value"]))
            for row in snap["right"]:
                key = (row["customer"], row["group"])
                self.right[key] = self.right.get(key, 0) + row["count"]
            self._rebuild_groups()
        if not os.path.exists(self._wal_path):
            return
        pending = {}
        with open(self._wal_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    break  # torn tail left by a crashed writer
                rtype = rec.get("type")
                batch = rec.get("batch")
                if rtype == "begin" and isinstance(batch, int):
                    pending[batch] = rec
                elif rtype == "commit" and isinstance(batch, int):
                    begun = pending.pop(batch, None)
                    if begun is not None and batch > self.version:
                        self._apply_canonical(begun["ops"])
                        self.version = batch

    def _rebuild_groups(self):
        self.groups = {}
        for cid, val in self.left.values():
            if cid is None:
                continue
            for (rcid, grp), mult in self.right.items():
                if rcid == cid:
                    stats = self.groups.get(grp)
                    if stats is None:
                        stats = self.groups[grp] = GroupStats()
                    stats.add(val, mult)

    def checkpoint(self):
        """Atomically snapshot the base tables and the published version."""
        if self._checkpoint_path is None:
            raise BatchError("engine is not bound to a state directory")
        snap = {
            "version": self.version,
            "left": [
                {"txid": txid, "customer": cid, "value": num_to_json(val)}
                for txid, (cid, val) in sorted(self.left.items(),
                                               key=lambda kv: str(kv[0]))
            ],
            "right": [
                {"customer": cid, "group": grp, "count": mult}
                for (cid, grp), mult in sorted(self.right.items(),
                                               key=lambda kv: str(kv[0]))
            ],
        }
        tmp = self._checkpoint_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(snap, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self._checkpoint_path)

    def _commit(self, canonical):
        self.version += 1
        if self._wal_path is None:
            return
        with open(self._wal_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "begin", "batch": self.version,
                                 "ops": canonical}) + "\n")
            fh.write(json.dumps({"type": "commit",
                                 "batch": self.version}) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    # ---------------------------------------------------------- batch apply

    def apply_batch(self, ops):
        """Apply one batch atomically; returns the new version."""
        canonical = [_canon_op(op) for op in ops]
        self._apply_canonical(canonical)
        self._commit(canonical)
        return self.version

    def _apply_canonical(self, canonical):
        prims = self._expand(canonical)
        left_old = dict(self.left)
        right_old = dict(self.right)
        undo = []
        try:
            delta_l, delta_r = self._apply_tables(prims, undo)
            contrib = self._delta_join(delta_l, delta_r, left_old, right_old)
            self._apply_contrib(contrib, undo)
        except BatchError:
            for action in reversed(undo):
                action()
            raise

    def _expand(self, canonical):
        """Expand canonical ops into signed table primitives."""
        prims = []
        for op in canonical:
            kind = op["op"]
            if kind == "insert_tx":
                prims.append(("L+", op["txid"], op["customer"],
                              num_from_json(op["value"])))
            elif kind == "retract_tx":
                prims.append(("L-", op["txid"]))
            elif kind == "replace_tx":
                prims.append(("L-", op["txid"]))
                prims.append(("L+", op["txid"], op["customer"],
                              num_from_json(op["value"])))
            elif kind == "insert_cust":
                prims.append(("R+", op["customer"], op["group"], op["count"]))
            elif kind == "retract_cust":
                prims.append(("R-", op["customer"], op["group"], op["count"]))
            elif kind == "migrate":
                cid, gfrom, gto = op["customer"], op["from"], op["to"]
                count = op["count"]
                if count is None:
                    count = self.right.get((cid, gfrom), 0)
                if count == 0:
                    raise BatchError(
                        f"nothing to migrate for customer {cid!r} "
                        f"from group {gfrom!r}")
                prims.append(("R-", cid, gfrom, count))
                prims.append(("R+", cid, gto, count))
        return prims

    def _right_add(self, key, delta):
        new = self.right.get(key, 0) + delta
        if new <= 0:
            self.right.pop(key, None)
        else:
            self.right[key] = new

    def _apply_tables(self, prims, undo):
        """Mutate the base tables, recording signed deltas and undo steps."""
        delta_l, delta_r = [], []
        for prim in prims:
            tag = prim[0]
            if tag == "L+":
                _, txid, cid, val = prim
                if txid in self.left:
                    raise BatchError(f"duplicate transaction id {txid!r}")
                self.left[txid] = (cid, val)
                undo.append(lambda txid=txid: self.left.pop(txid))
                delta_l.append((cid, val, 1))
            elif tag == "L-":
                _, txid = prim
                old = self.left.pop(txid, None)
                if old is None:
                    raise BatchError(f"unknown transaction id {txid!r}")
                undo.append(
                    lambda txid=txid, old=old: self.left.__setitem__(txid, old))
                delta_l.append((old[0], old[1], -1))
            elif tag == "R+":
                _, cid, grp, count = prim
                key = (cid, grp)
                self._right_add(key, count)
                undo.append(
                    lambda key=key, count=count: self._right_add(key, -count))
                delta_r.append((cid, grp, count))
            else:  # "R-"
                _, cid, grp, count = prim
                key = (cid, grp)
                have = self.right.get(key, 0)
                if have < count:
                    raise BatchError(
                        f"retract of {count} row(s) from {key!r} exceeds "
                        f"multiplicity {have}")
                self._right_add(key, -count)
                undo.append(
                    lambda key=key, count=count: self._right_add(key, count))
                delta_r.append((cid, grp, -count))
        return delta_l, delta_r

    @staticmethod
    def _delta_join(delta_l, delta_r, left_old, right_old):
        """dL|x|R_old + L_old|x|dR + dL|x|dR as (group, value) -> signed n."""
        contrib = {}

        def bump(grp, val, delta):
            if delta:
                contrib[(grp, val)] = contrib.get((grp, val), 0) + delta

        for cid, val, sign in delta_l:
            if cid is None:
                continue
            for (rcid, grp), mult in right_old.items():
                if rcid == cid:
                    bump(grp, val, sign * mult)
        for cid, grp, delta in delta_r:
            if cid is None:
                continue
            for lcid, val in left_old.values():
                if lcid == cid:
                    bump(grp, val, delta)
        for lcid, val, sign in delta_l:
            if lcid is None:
                continue
            for rcid, grp, delta in delta_r:
                if rcid == lcid:
                    bump(grp, val, sign * delta)
        return contrib

    def _apply_contrib(self, contrib, undo):
        for (grp, val), delta in contrib.items():
            stats = self.groups.get(grp)
            if stats is None:
                stats = self.groups[grp] = GroupStats()
            try:
                stats.add(val, delta)
            except (ValueError, KeyError) as exc:
                raise BatchError(
                    f"view update failed for group {grp!r}: {exc}") from exc
            undo.append(lambda stats=stats, val=val, delta=delta:
                        stats.add(val, -delta))

    # ---------------------------------------------------------- read side

    def view(self):
        """{group: {"count", "sum", "median"}} for non-empty groups."""
        out = {}
        for grp, stats in self.groups.items():
            if stats.count == 0:
                continue
            out[grp] = {"count": stats.count, "sum": stats.sum,
                        "median": stats.median}
        return out

    def cursor(self):
        """Published output cursor; only advances when a batch commits."""
        return {"version": self.version, "view": self.view()}

    def view_json(self):
        groups = [
            {"group": grp, "count": stats["count"],
             "sum": num_to_json(stats["sum"]),
             "median": num_to_json(stats["median"])}
            for grp, stats in sorted(self.view().items(),
                                     key=lambda kv: str(kv[0]))
        ]
        return {"version": self.version, "groups": groups}

    def rank(self, group, value):
        stats = self.groups.get(group)
        if stats is None or stats.count == 0:
            raise BatchError(f"unknown group {group!r}")
        return stats.rank(value)

    def select(self, group, k):
        stats = self.groups.get(group)
        if stats is None or stats.count == 0:
            raise BatchError(f"unknown group {group!r}")
        try:
            return stats.select(k)
        except IndexError:
            raise BatchError(
                f"rank {k} out of range for group {group!r}") from None
