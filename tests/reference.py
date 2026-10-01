"""Independent reference implementation used to cross-check ``sched``.

Everything here is deliberately written from first principles (exhaustive
enumeration) so that the randomized tests compare the optimized scheduler
against a brute-force oracle rather than against itself.
"""

from __future__ import annotations

from itertools import combinations
from typing import Any, Dict, List, Optional, Sequence, Tuple

OpRef = Tuple[str, int]


def op_list(transactions: Sequence[Dict[str, Any]]) -> List[OpRef]:
    return [
        (txn["id"], idx)
        for txn in transactions
        for idx in range(len(txn.get("ops", [])))
    ]


def reference_positions(
    transactions: Sequence[Dict[str, Any]],
    order: Optional[Sequence[Sequence[Any]]],
) -> Dict[OpRef, int]:
    if order is None:
        return {ref: pos for pos, ref in enumerate(op_list(transactions))}
    return {(ref[0], ref[1]): pos for pos, ref in enumerate(order)}


def get_op(transactions: Sequence[Dict[str, Any]], ref: OpRef) -> Dict[str, Any]:
    for txn in transactions:
        if txn["id"] == ref[0]:
            return txn["ops"][ref[1]]
    raise KeyError(ref)


def ops_conflict(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    return a["key"] == b["key"] and (
        a["type"] == "write" or b["type"] == "write"
    )


def build_predecessors(
    transactions: Sequence[Dict[str, Any]],
    order: Optional[Sequence[Sequence[Any]]] = None,
) -> Dict[OpRef, set]:
    """Op-level precedence edges, derived independently of ``sched``."""

    preds: Dict[OpRef, set] = {ref: set() for ref in op_list(transactions)}
    position = reference_positions(transactions, order)

    for txn in transactions:
        for idx in range(len(txn.get("ops", [])) - 1):
            preds[(txn["id"], idx + 1)].add((txn["id"], idx))

    refs = op_list(transactions)
    for first, second in combinations(refs, 2):
        if first[0] == second[0]:
            continue
        if ops_conflict(get_op(transactions, first), get_op(transactions, second)):
            if position[first] < position[second]:
                preds[second].add(first)
            else:
                preds[first].add(second)
    return preds


def txn_precedence_edges(
    transactions: Sequence[Dict[str, Any]],
    order: Optional[Sequence[Sequence[Any]]] = None,
) -> set:
    preds = build_predecessors(transactions, order)
    edges = set()
    for ref, before in preds.items():
        for other in before:
            if other[0] != ref[0]:
                edges.add((other[0], ref[0]))
    return edges


def all_topological_orders(preds: Dict[OpRef, set]) -> List[List[OpRef]]:
    """Enumerate every topological order of the op-level precedence DAG."""

    remaining = {ref: set(before) for ref, before in preds.items()}
    orders: List[List[OpRef]] = []
    current: List[OpRef] = []

    def backtrack() -> None:
        if not remaining:
            orders.append(list(current))
            return
        for ref in sorted(r for r, before in remaining.items() if not before):
            del remaining[ref]
            for before in remaining.values():
                before.discard(ref)
            current.append(ref)
            backtrack()
            current.pop()
            for other in remaining:
                if ref in preds[other]:
                    remaining[other].add(ref)
            remaining[ref] = {p for p in preds[ref] if p in remaining}

    backtrack()
    return orders


def exhaustive_min_rounds(preds: Dict[OpRef, set]) -> int:
    """Minimum R such that ops can be assigned rounds 0..R-1 with
    round(u) < round(v) for every precedence edge u -> v."""

    refs = sorted(preds)
    n = len(refs)
    if n == 0:
        return 0
    succs: Dict[OpRef, set] = {ref: set() for ref in refs}
    for ref, before in preds.items():
        for other in before:
            succs[other].add(ref)

    # Assign in a topological order so predecessors are placed first.
    indeg = {ref: len(before) for ref, before in preds.items()}
    topo = []
    queue = sorted(ref for ref, deg in indeg.items() if deg == 0)
    while queue:
        ref = queue.pop(0)
        topo.append(ref)
        for after in sorted(succs[ref]):
            indeg[after] -= 1
            if indeg[after] == 0:
                queue.append(after)

    for limit in range(1, n + 1):
        assign: Dict[OpRef, int] = {}

        def backtrack(k: int) -> bool:
            if k == n:
                return True
            ref = topo[k]
            low = 0
            for before in preds[ref]:
                low = max(low, assign[before] + 1)
            for round_no in range(low, limit):
                if any(
                    round_no >= assign[after]
                    for after in succs[ref]
                    if after in assign
                ):
                    continue
                assign[ref] = round_no
                if backtrack(k + 1):
                    return True
                del assign[ref]
            return False

        if backtrack(0):
            return limit
    return n  # pragma: no cover - unreachable for a DAG


def serial_final_state(
    transactions: Sequence[Dict[str, Any]],
    order: Optional[Sequence[Sequence[Any]]] = None,
) -> Dict[Any, Any]:
    """Final key/value state after executing the reference serial order."""

    position = reference_positions(transactions, order)
    state: Dict[Any, Any] = {}
    for ref in sorted(position, key=position.__getitem__):
        op = get_op(transactions, ref)
        if op["type"] == "write":
            state[op["key"]] = op.get("value")
    return state


def parallel_final_state(
    transactions: Sequence[Dict[str, Any]], rounds: Sequence[Sequence[Sequence[Any]]]
) -> Dict[Any, Any]:
    """Final key/value state after executing a round-based schedule."""

    state: Dict[Any, Any] = {}
    for rnd in rounds:
        for txn_id, idx in rnd:
            op = get_op(transactions, (txn_id, idx))
            if op["type"] == "write":
                state[op["key"]] = op.get("value")
    return state
