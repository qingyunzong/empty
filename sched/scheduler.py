"""Conflict-serializable round-based parallel scheduler.

Semantics
---------
The input is a set of transactions, each an ordered list of read/write
operations on keys.  The *natural order* of the operations is the
lock-step interleaving implied by the input: all first operations (in
ascending transaction-id order), then all second operations, and so on.

Two operations *conflict* iff they belong to different transactions,
touch the same key, and at least one of them is a write.

The *precedence graph* has one node per transaction and an edge
``Ti -> Tj`` whenever an operation of ``Ti`` conflicts with, and
precedes (in natural order), an operation of ``Tj``.  If this graph
contains a cycle, the input is not conflict-serializable and a
``NON_SERIALIZABLE`` error describing one such cycle is produced.

Otherwise a schedule organised in rounds is emitted such that:

* every precedence constraint (intra-transaction order and every
  conflicting pair, oriented by the natural order) goes from an earlier
  round to a strictly later round -- hence operations inside one round
  are pairwise non-conflicting and may run in parallel;
* the number of rounds is minimal (equal to the length of the longest
  chain of constraints, in operations);
* ties are broken deterministically: round by round, the sorted list of
  ``(txn_id, op_index)`` pairs is lexicographically minimal.
"""

from __future__ import annotations

from collections import deque

READ = "read"
WRITE = "write"


class NonSerializableError(Exception):
    """Raised when the precedence graph of the input contains a cycle."""

    def __init__(self, cycle):
        self.cycle = list(cycle)
        message = "NON_SERIALIZABLE: " + " -> ".join(map(str, self.cycle))
        super().__init__(message)


def txn_sort_key(txn_id):
    """Deterministic total order for transaction ids.

    Numbers sort numerically before strings, strings lexicographically;
    anything else is compared by its string representation.
    """
    if isinstance(txn_id, bool):
        return (1, str(txn_id))
    if isinstance(txn_id, (int, float)):
        return (0, txn_id)
    return (1, str(txn_id))


def op_sort_key(op):
    """Sort key for an operation reference ``(txn_rank, op_index)``."""
    return (op[0], op[1])


def normalize(data):
    """Validate the input document and return a sorted transaction list.

    Returns a list of ``(txn_id, ops)`` sorted by :func:`txn_sort_key`,
    where ``ops`` is a list of ``(op_type, key)`` tuples.
    """
    if isinstance(data, dict) and isinstance(data.get("transactions"), list):
        raw_txns = data["transactions"]
    elif isinstance(data, list):
        raw_txns = data
    else:
        raise ValueError(
            "input must be a JSON object with a 'transactions' list"
        )

    txns = []
    seen_ids = set()
    for pos, txn in enumerate(raw_txns):
        if not isinstance(txn, dict):
            raise ValueError(f"transaction #{pos} must be an object")
        txn_id = txn.get("id", pos)
        try:
            already = txn_id in seen_ids
        except TypeError:
            raise ValueError(f"unhashable transaction id: {txn_id!r}") from None
        if already:
            raise ValueError(f"duplicate transaction id: {txn_id!r}")
        seen_ids.add(txn_id)

        raw_ops = txn.get("ops", [])
        if not isinstance(raw_ops, list):
            raise ValueError(f"transaction {txn_id!r}: 'ops' must be a list")
        ops = []
        for index, op in enumerate(raw_ops):
            if not isinstance(op, dict):
                raise ValueError(
                    f"transaction {txn_id!r} op #{index} must be an object"
                )
            op_type = op.get("type", op.get("op"))
            if isinstance(op_type, str):
                op_type = op_type.lower()
            if op_type not in (READ, WRITE):
                raise ValueError(
                    f"transaction {txn_id!r} op #{index}: "
                    f"type must be 'read' or 'write', got {op_type!r}"
                )
            if "key" not in op:
                raise ValueError(
                    f"transaction {txn_id!r} op #{index}: missing 'key'"
                )
            key = op["key"]
            try:
                hash(key)
            except TypeError:
                raise ValueError(
                    f"transaction {txn_id!r} op #{index}: "
                    f"unhashable key {key!r}"
                ) from None
            ops.append((op_type, key))
        txns.append((txn_id, ops))

    txns.sort(key=lambda item: txn_sort_key(item[0]))
    return txns


def build_model(txns):
    """Build the operation-level constraint DAG.

    Returns ``(ops, preds, succs)`` where each operation is a
    ``(txn_rank, op_index)`` tuple.  Edges come from intra-transaction
    order and from conflicting pairs oriented by the natural order
    ``(op_index, txn_rank)``.
    """
    ops = []
    preds = {}
    succs = {}
    for txn_rank, (_txn_id, txn_ops) in enumerate(txns):
        for op_index in range(len(txn_ops)):
            op = (txn_rank, op_index)
            ops.append(op)
            preds[op] = set()
            succs[op] = set()

    def add_edge(before, after):
        if after not in succs[before]:
            succs[before].add(after)
            preds[after].add(before)

    for txn_rank, (_txn_id, txn_ops) in enumerate(txns):
        for op_index in range(len(txn_ops) - 1):
            add_edge((txn_rank, op_index), (txn_rank, op_index + 1))

    by_key = {}
    for op in ops:
        txn_rank, op_index = op
        key = txns[txn_rank][1][op_index][1]
        by_key.setdefault(key, []).append(op)

    for key_ops in by_key.values():
        for left in range(len(key_ops)):
            for right in range(left + 1, len(key_ops)):
                first = key_ops[left]
                second = key_ops[right]
                if first[0] == second[0]:
                    continue
                first_type = txns[first[0]][1][first[1]][0]
                second_type = txns[second[0]][1][second[1]][0]
                if first_type != WRITE and second_type != WRITE:
                    continue
                if (first[1], first[0]) <= (second[1], second[0]):
                    add_edge(first, second)
                else:
                    add_edge(second, first)

    return ops, preds, succs


def find_cycle(txns, succs):
    """Return one cycle of the transaction-level precedence graph.

    The cycle is a list of transaction ids, rotated so it starts with
    the smallest id; ``None`` if the graph is acyclic.  Deterministic:
    nodes and neighbours are visited in sorted order.
    """
    txn_succ = [set() for _ in txns]
    for (txn_rank, _op_index), targets in succs.items():
        for (target_rank, _) in targets:
            if target_rank != txn_rank:
                txn_succ[txn_rank].add(target_rank)

    order = sorted(range(len(txns)), key=lambda t: txn_sort_key(txns[t][0]))
    sorted_succ = {
        t: sorted(txn_succ[t], key=lambda u: txn_sort_key(txns[u][0]))
        for t in range(len(txns))
    }

    WHITE, GRAY, BLACK = 0, 1, 2
    color = {t: WHITE for t in range(len(txns))}
    for start in order:
        if color[start] != WHITE:
            continue
        color[start] = GRAY
        path = [start]
        stack = [(start, iter(sorted_succ[start]))]
        while stack:
            node, neighbours = stack[-1]
            descended = False
            for nxt in neighbours:
                if color[nxt] == GRAY:
                    cycle = path[path.index(nxt):]
                    pivot = min(
                        range(len(cycle)),
                        key=lambda j: txn_sort_key(txns[cycle[j]][0]),
                    )
                    cycle = cycle[pivot:] + cycle[:pivot]
                    return [txns[t][0] for t in cycle]
                if color[nxt] == WHITE:
                    color[nxt] = GRAY
                    path.append(nxt)
                    stack.append((nxt, iter(sorted_succ[nxt])))
                    descended = True
                    break
            if not descended:
                color[node] = BLACK
                stack.pop()
                path.pop()
    return None


def _heights(preds, succs, remaining):
    """Longest-path length (in edges) ending at each remaining op."""
    indegree = {op: 0 for op in remaining}
    for op in remaining:
        indegree[op] = sum(1 for p in preds[op] if p in remaining)
    height = {op: 0 for op in remaining}
    queue = deque(op for op in remaining if indegree[op] == 0)
    while queue:
        node = queue.popleft()
        for nxt in succs[node]:
            if nxt not in remaining:
                continue
            if height[node] + 1 > height[nxt]:
                height[nxt] = height[node] + 1
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)
    return height


def schedule(txns):
    """Compute the minimal-round deterministic schedule.

    ``txns`` is the normalized list returned by :func:`normalize`.
    Returns a list of rounds; each round is a list of ``(txn_rank,
    op_index)`` sorted lexicographically.

    Raises :class:`NonSerializableError` if the transaction-level
    precedence graph contains a cycle.
    """
    ops, preds, succs = build_model(txns)
    cycle = find_cycle(txns, succs)
    if cycle is not None:
        raise NonSerializableError(cycle)

    remaining = set(ops)
    rounds = []
    while remaining:
        heights = _heights(preds, succs, remaining)
        target = max(heights.values())
        sources = sorted(
            (op for op in remaining if not (preds[op] & remaining)),
            key=op_sort_key,
        )
        # Lexicographically smallest feasible round: the shortest prefix
        # of the sorted source list whose removal reduces the remaining
        # longest chain by one.
        chosen = []
        rest = set(remaining)
        for op in sources:
            chosen.append(op)
            rest.discard(op)
            if not rest:
                break
            if max(_heights(preds, succs, rest).values()) < target:
                break
        rounds.append(chosen)
        remaining = rest
    return rounds


def schedule_transactions(data):
    """Schedule the input document; returns a JSON-able dict."""
    txns = normalize(data)
    rounds = schedule(txns)
    return {
        "rounds": [
            [
                {
                    "txn": txns[txn_rank][0],
                    "op_index": op_index,
                    "type": txns[txn_rank][1][op_index][0],
                    "key": txns[txn_rank][1][op_index][1],
                }
                for (txn_rank, op_index) in round_ops
            ]
            for round_ops in rounds
        ]
    }


def write_value(txn_id, op_index):
    """Deterministic value written by a write operation (for simulation)."""
    return f"{txn_id}#{op_index}"


def simulate(txns, order):
    """Simulate executing ``order`` (a sequence of ``(txn_rank, op_index)``).

    A write stores :func:`write_value`; reads observe the latest write.
    Returns the final ``{key: value}`` state.
    """
    state = {}
    for txn_rank, op_index in order:
        op_type, key = txns[txn_rank][1][op_index]
        if op_type == WRITE:
            state[key] = write_value(txns[txn_rank][0], op_index)
    return state
