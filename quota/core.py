"""Quota tree transaction engine.

State is a tree of nodes: {"id", "limit", "used", "children"}.
A transaction is {"ops": [{"op": "add"|"sub", "path": [id, ...], "amount": int}]}.

Semantics:
- add: every node on path (ancestors including self) must satisfy
  used + amount <= limit (limit null means unbounded). Descendants unchanged.
- sub: no node's used may become negative.
- Atomic: any op failure aborts the whole transaction; the original state
  is preserved and the index of the first failing op is reported.
"""

import copy


class ValidationError(Exception):
    """Malformed input (state, tx, op). Maps to CLI exit code 2."""


class OpError(Exception):
    """A single op failed semantically. Aborts the transaction."""


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_id(value):
    return isinstance(value, (str, int)) and not isinstance(value, bool)


def validate_node(node, where="root"):
    """Validate a state tree rooted at `node`. Raises ValidationError."""
    if not isinstance(node, dict):
        raise ValidationError(f"{where}: node must be an object")
    for field in ("id", "limit", "used", "children"):
        if field not in node:
            raise ValidationError(f"{where}: missing field {field!r}")
    if not _is_id(node["id"]):
        raise ValidationError(f"{where}: 'id' must be a string or integer")
    limit = node["limit"]
    if limit is not None:
        if not _is_int(limit):
            raise ValidationError(f"{where}: 'limit' must be an integer or null")
        if limit < 0:
            raise ValidationError(f"{where}: 'limit' must be non-negative")
    used = node["used"]
    if not _is_int(used):
        raise ValidationError(f"{where}: 'used' must be an integer")
    if used < 0:
        raise ValidationError(f"{where}: 'used' must be non-negative")
    if limit is not None and used > limit:
        raise ValidationError(f"{where}: 'used' exceeds 'limit'")
    children = node["children"]
    if not isinstance(children, list):
        raise ValidationError(f"{where}: 'children' must be a list")
    seen = set()
    for index, child in enumerate(children):
        validate_node(child, f"{where}.children[{index}]")
        if child["id"] in seen:
            raise ValidationError(
                f"{where}: duplicate child id {child['id']!r} among siblings"
            )
        seen.add(child["id"])


def validate_tx(tx):
    """Validate a transaction document. Raises ValidationError."""
    if not isinstance(tx, dict):
        raise ValidationError("tx: must be an object")
    ops = tx.get("ops")
    if not isinstance(ops, list):
        raise ValidationError("tx: 'ops' must be a list")
    for index, op in enumerate(ops):
        where = f"ops[{index}]"
        if not isinstance(op, dict):
            raise ValidationError(f"{where}: op must be an object")
        if op.get("op") not in ("add", "sub"):
            raise ValidationError(f"{where}: 'op' must be 'add' or 'sub'")
        path = op.get("path")
        if not isinstance(path, list) or not path:
            raise ValidationError(f"{where}: 'path' must be a non-empty list")
        for node_id in path:
            if not _is_id(node_id):
                raise ValidationError(
                    f"{where}: path ids must be strings or integers"
                )
        if len(set(path)) != len(path):
            raise ValidationError(f"{where}: cyclic path (repeated id)")
        amount = op.get("amount")
        if not _is_int(amount):
            raise ValidationError(f"{where}: 'amount' must be an integer")
        if amount < 0:
            raise ValidationError(f"{where}: 'amount' must be non-negative")


def _resolve_path(root, path):
    """Return the list of nodes along `path` (root first). Raises OpError."""
    if path[0] != root["id"]:
        raise OpError(f"path does not start at root id {root['id']!r}")
    node = root
    nodes = [node]
    for node_id in path[1:]:
        child = next((c for c in node["children"] if c["id"] == node_id), None)
        if child is None:
            raise OpError(f"path not found: no child {node_id!r} under {node['id']!r}")
        nodes.append(child)
        node = child
    return nodes


def _apply_op(root, op):
    """Apply one op in place. Raises OpError on semantic failure."""
    nodes = _resolve_path(root, op["path"])
    amount = op["amount"]
    if op["op"] == "add":
        for node in nodes:
            limit = node["limit"]
            if limit is not None and node["used"] + amount > limit:
                raise OpError(
                    f"add would exceed limit at node {node['id']!r}: "
                    f"{node['used']} + {amount} > {limit}"
                )
        for node in nodes:
            node["used"] += amount
    else:  # sub
        for node in nodes:
            if node["used"] - amount < 0:
                raise OpError(
                    f"sub would make 'used' negative at node {node['id']!r}: "
                    f"{node['used']} - {amount} < 0"
                )
        for node in nodes:
            node["used"] -= amount


def apply_tx(state, tx):
    """Apply a transaction atomically.

    Returns (new_state, None, None) on success, or
    (None, first_error_index, message) on failure; `state` is never mutated.
    """
    work = copy.deepcopy(state)
    for index, op in enumerate(tx["ops"]):
        try:
            _apply_op(work, op)
        except OpError as exc:
            return None, index, str(exc)
    return work, None, None
