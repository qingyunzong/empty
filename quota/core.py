"""Core quota-tree transaction logic.

State is a tree of nodes: {"id", "limit", "used", "children"}.
A tx is {"ops": [{"op": "add"|"sub", "path": [id, ...], "amount": int}]}.

Applying a tx is atomic: either every op succeeds and a new state is
returned, or the tx has no effect at all and the original state is
returned together with the index of the first failing op.
"""

from __future__ import annotations

import copy


class TxError(Exception):
    """Structural / validation error in state or tx (CLI exit code 2)."""


class OpFailure(Exception):
    """A single op violated quota semantics (tx rolls back, exit code 1)."""


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_node(node, where):
    if not isinstance(node, dict):
        raise TxError(f"node at {where} is not an object")
    for field in ("id", "limit", "used", "children"):
        if field not in node:
            raise TxError(f"node at {where} missing field {field!r}")
    if not isinstance(node["id"], (str, int)) or isinstance(node["id"], bool):
        raise TxError(f"node at {where} has invalid id")
    limit = node["limit"]
    if limit is not None and not _is_int(limit):
        raise TxError(f"node at {where} has non-integer limit")
    if not _is_int(node["used"]):
        raise TxError(f"node at {where} has non-integer used")
    if node["used"] < 0:
        raise TxError(f"node at {where} has negative used")
    if not isinstance(node["children"], list):
        raise TxError(f"node at {where} children is not a list")
    for i, child in enumerate(node["children"]):
        _validate_node(child, f"{where}.children[{i}]")


def validate_state(state):
    """Raise TxError unless state is a well-formed quota tree."""
    if not isinstance(state, dict) or "id" not in state:
        raise TxError("root node missing")
    _validate_node(state, "$")


def validate_tx(tx):
    """Raise TxError unless tx is structurally valid."""
    if not isinstance(tx, dict) or not isinstance(tx.get("ops"), list):
        raise TxError("tx must be an object with an 'ops' list")
    for i, op in enumerate(tx["ops"]):
        where = f"ops[{i}]"
        if not isinstance(op, dict):
            raise TxError(f"{where} is not an object")
        if op.get("op") not in ("add", "sub"):
            raise TxError(f"{where}.op must be 'add' or 'sub'")
        path = op.get("path")
        if not isinstance(path, list) or not path:
            raise TxError(f"{where}.path must be a non-empty list")
        if len(set(map(repr, path))) != len(path):
            raise TxError(f"{where}.path contains a cycle (repeated id)")
        if not _is_int(op.get("amount")):
            raise TxError(f"{where}.amount is not an integer")


def _resolve(root, path):
    """Return the chain of nodes from root down to path[-1]."""
    if root["id"] != path[0]:
        raise OpFailure(f"path not found: root id is {root['id']!r}, "
                        f"path starts with {path[0]!r}")
    chain = [root]
    node = root
    for ident in path[1:]:
        child = next((c for c in node["children"] if c["id"] == ident), None)
        if child is None:
            raise OpFailure(f"path not found: no child {ident!r} "
                            f"under {node['id']!r}")
        chain.append(child)
        node = child
    return chain


def _apply_op(root, op):
    chain = _resolve(root, op["path"])
    amount = op["amount"]
    if op["op"] == "add":
        for node in chain:
            limit = node["limit"]
            if limit is not None and node["used"] + amount > limit:
                raise OpFailure(
                    f"add of {amount} exceeds limit {limit} at node "
                    f"{node['id']!r} (used={node['used']})")
        for node in chain:
            node["used"] += amount
    else:  # sub
        for node in chain:
            if node["used"] - amount < 0:
                raise OpFailure(
                    f"sub of {amount} makes used negative at node "
                    f"{node['id']!r} (used={node['used']})")
        for node in chain:
            node["used"] -= amount


def apply_tx(state, tx):
    """Apply tx to state atomically.

    Returns (new_state, None) on success, or (state, first_error_index)
    on failure, in which case the returned state is the untouched input.
    """
    work = copy.deepcopy(state)
    for index, op in enumerate(tx["ops"]):
        try:
            _apply_op(work, op)
        except OpFailure:
            return state, index
    return work, None
