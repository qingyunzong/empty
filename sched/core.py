"""Core scheduling logic for the sched package.

Input model
-----------
A workload is a list of transactions.  Each transaction has a unique
string id and an ordered list of operations.  An operation is a mapping
with keys:

* ``type``:  ``"read"`` or ``"write"`` (required),
* ``key``:   the name of the data item (required),
* ``value``: optional payload for writes (used to compare final states).

The direction of a conflicting pair of operations from different
transactions is fixed by a *reference order*: either an explicit global
interleaving supplied by the caller (a permutation of all ``[txn_id,
op_index]`` references), or the implicit serial order T1, T2, ..., Tn
(each transaction's operations in sequence).  The produced parallel
schedule is conflict-equivalent to that serial order.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations
from typing import Any, Dict, Hashable, Iterable, List, Optional, Sequence, Tuple

READ = "read"
WRITE = "write"

NON_SERIALIZABLE = "NON_SERIALIZABLE"

OpRef = Tuple[str, int]  # (txn_id, op_index)


class ScheduleError(ValueError):
    """Raised when the workload description is malformed."""


@dataclass(frozen=True)
class Op:
    """A single read or write operation."""

    type: str
    key: Hashable
    value: Any = None

    def __post_init__(self) -> None:
        if self.type not in (READ, WRITE):
            raise ScheduleError(
                f"invalid operation type {self.type!r}; expected 'read' or 'write'"
            )

    @property
    def is_write(self) -> bool:
        return self.type == WRITE


def conflicts(a: Op, b: Op) -> bool:
    """Two operations conflict iff same key and at least one is a write."""

    return a.key == b.key and (a.is_write or b.is_write)


@dataclass
class _Txn:
    txn_id: str
    ops: List[Op] = field(default_factory=list)


def _normalize_transactions(
    transactions: Sequence[Dict[str, Any]],
) -> List[_Txn]:
    if not isinstance(transactions, Sequence) or isinstance(transactions, (str, bytes)):
        raise ScheduleError("'transactions' must be a list")
    txns: List[_Txn] = []
    seen: set = set()
    for pos, raw in enumerate(transactions):
        if not isinstance(raw, dict):
            raise ScheduleError(f"transaction #{pos} must be an object")
        if "id" not in raw:
            raise ScheduleError(f"transaction #{pos} is missing 'id'")
        txn_id = raw["id"]
        if not isinstance(txn_id, str):
            raise ScheduleError(f"transaction id must be a string, got {txn_id!r}")
        if txn_id in seen:
            raise ScheduleError(f"duplicate transaction id {txn_id!r}")
        seen.add(txn_id)
        raw_ops = raw.get("ops", [])
        if not isinstance(raw_ops, Sequence) or isinstance(raw_ops, (str, bytes)):
            raise ScheduleError(f"'ops' of transaction {txn_id!r} must be a list")
        ops: List[Op] = []
        for op_pos, raw_op in enumerate(raw_ops):
            if not isinstance(raw_op, dict):
                raise ScheduleError(
                    f"op #{op_pos} of transaction {txn_id!r} must be an object"
                )
            try:
                op_type = raw_op["type"]
                key = raw_op["key"]
            except KeyError as exc:
                raise ScheduleError(
                    f"op #{op_pos} of transaction {txn_id!r} is missing {exc}"
                ) from exc
            try:
                ops.append(Op(type=op_type, key=key, value=raw_op.get("value")))
            except ScheduleError as exc:
                raise ScheduleError(
                    f"op #{op_pos} of transaction {txn_id!r}: {exc}"
                ) from exc
        txns.append(_Txn(txn_id=txn_id, ops=ops))
    return txns


def _reference_positions(
    txns: List[_Txn],
    order: Optional[Sequence[Sequence[Any]]],
) -> Dict[OpRef, int]:
    """Map every operation to its position in the reference serial order."""

    if order is None:
        position: Dict[OpRef, int] = {}
        pos = 0
        for txn in txns:
            for idx in range(len(txn.ops)):
                position[(txn.txn_id, idx)] = pos
                pos += 1
        return position

    sizes = {txn.txn_id: len(txn.ops) for txn in txns}
    position = {}
    seen: set = set()
    for pos, ref in enumerate(order):
        if (
            not isinstance(ref, Sequence)
            or isinstance(ref, (str, bytes))
            or len(ref) != 2
        ):
            raise ScheduleError(
                f"order entry #{pos} must be a [txn_id, op_index] pair"
            )
        txn_id, idx = ref[0], ref[1]
        if not isinstance(idx, int) or isinstance(idx, bool):
            raise ScheduleError(f"order entry #{pos}: op_index must be an int")
        if txn_id not in sizes:
            raise ScheduleError(f"order entry #{pos}: unknown transaction {txn_id!r}")
        if not 0 <= idx < sizes[txn_id]:
            raise ScheduleError(
                f"order entry #{pos}: op_index {idx} out of range for {txn_id!r}"
            )
        op_ref = (txn_id, idx)
        if op_ref in seen:
            raise ScheduleError(f"order entry #{pos}: duplicate reference {op_ref!r}")
        seen.add(op_ref)
        position[op_ref] = pos
    total = sum(sizes.values())
    if len(position) != total:
        missing = [
            (txn.txn_id, idx)
            for txn in txns
            for idx in range(len(txn.ops))
            if (txn.txn_id, idx) not in position
        ]
        raise ScheduleError(f"order does not cover all operations; missing {missing!r}")
    for txn in txns:
        positions = [position[(txn.txn_id, idx)] for idx in range(len(txn.ops))]
        if positions != sorted(positions):
            raise ScheduleError(
                f"order violates the internal operation order of transaction "
                f"{txn.txn_id!r}"
            )
    return position


def _build_edges(
    txns: List[_Txn], position: Dict[OpRef, int]
) -> Tuple[Dict[OpRef, set], Dict[OpRef, set]]:
    """Return (predecessors, successors) for every operation."""

    preds: Dict[OpRef, set] = {}
    succs: Dict[OpRef, set] = {}
    for txn in txns:
        for idx in range(len(txn.ops)):
            preds[(txn.txn_id, idx)] = set()
            succs[(txn.txn_id, idx)] = set()

    def add_edge(before: OpRef, after: OpRef) -> None:
        if after not in succs[before]:
            succs[before].add(after)
            preds[after].add(before)

    # Intra-transaction program order.
    for txn in txns:
        for idx in range(len(txn.ops) - 1):
            add_edge((txn.txn_id, idx), (txn.txn_id, idx + 1))

    # Inter-transaction conflicts, directed by the reference order.
    for left, right in combinations(txns, 2):
        for i, op_left in enumerate(left.ops):
            for j, op_right in enumerate(right.ops):
                if conflicts(op_left, op_right):
                    ref_left = (left.txn_id, i)
                    ref_right = (right.txn_id, j)
                    if position[ref_left] < position[ref_right]:
                        add_edge(ref_left, ref_right)
                    else:
                        add_edge(ref_right, ref_left)
    return preds, succs


def _find_cycle(txn_ids: Iterable[str], adj: Dict[str, set]) -> Optional[List[str]]:
    """Return one cycle of transaction ids, or None if the graph is a DAG.

    The cycle is returned as ``[v0, v1, ..., vk]`` meaning the edges
    ``v0 -> v1 -> ... -> vk -> v0`` exist.  Traversal order is
    deterministic (ids sorted lexicographically).
    """

    WHITE, GRAY, BLACK = 0, 1, 2
    color = {t: WHITE for t in txn_ids}
    for start in sorted(color):
        if color[start] != WHITE:
            continue
        color[start] = GRAY
        path = [start]
        stack = [(start, iter(sorted(adj[start])))]
        while stack:
            node, neighbors = stack[-1]
            descended = False
            for nxt in neighbors:
                if color[nxt] == WHITE:
                    color[nxt] = GRAY
                    path.append(nxt)
                    stack.append((nxt, iter(sorted(adj[nxt]))))
                    descended = True
                    break
                if color[nxt] == GRAY:
                    return path[path.index(nxt):]
            if not descended:
                color[node] = BLACK
                stack.pop()
                path.pop()
    return None


def schedule_transactions(
    transactions: Sequence[Dict[str, Any]],
    order: Optional[Sequence[Sequence[Any]]] = None,
) -> Dict[str, Any]:
    """Build a minimal-round conflict-serializable parallel schedule.

    ``transactions`` is a list of ``{"id": str, "ops": [...]}`` mappings.
    ``order`` optionally fixes the reference serial order as a permutation
    of ``[txn_id, op_index]`` pairs; when omitted, the serial order
    T1..Tn (each transaction's ops in sequence) is used.

    Returns either
    ``{"rounds": [[[txn_id, op_index], ...], ...], "num_rounds": int}``
    or ``{"error": "NON_SERIALIZABLE", "cycle": [txn_id, ...]}``.
    """

    txns = _normalize_transactions(transactions)
    position = _reference_positions(txns, order)
    preds, succs = _build_edges(txns, position)

    # Cycle detection on the transaction-level precedence graph.
    txn_adj: Dict[str, set] = {txn.txn_id: set() for txn in txns}
    for before, afters in succs.items():
        for after in afters:
            if before[0] != after[0]:
                txn_adj[before[0]].add(after[0])
    cycle = _find_cycle(txn_adj.keys(), txn_adj)
    if cycle is not None:
        return {"error": NON_SERIALIZABLE, "cycle": cycle}

    # Kahn's algorithm in layers: every operation is placed in the
    # earliest round its predecessors allow (its longest-path level),
    # which attains the lower bound given by the longest dependency
    # chain and is therefore round-minimal.  Within a round, operations
    # are listed in lexicographic (txn_id, op_index) order.
    in_degree = {ref: len(preds[ref]) for ref in preds}
    ready = sorted(ref for ref, deg in in_degree.items() if deg == 0)
    rounds: List[List[List[Any]]] = []
    placed = 0
    while ready:
        rounds.append([[txn_id, idx] for txn_id, idx in ready])
        placed += len(ready)
        nxt: List[OpRef] = []
        for ref in ready:
            for after in succs[ref]:
                in_degree[after] -= 1
                if in_degree[after] == 0:
                    nxt.append(after)
        ready = sorted(nxt)
    if placed != len(in_degree):  # pragma: no cover - guarded by cycle check
        raise ScheduleError("internal error: operation-level cycle detected")

    return {"rounds": rounds, "num_rounds": len(rounds)}
