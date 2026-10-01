"""Core delta/apply logic.

Cost model: each literal byte costs 1, each copy op costs a flat 2.
A copy op may reference any non-empty in-bounds range of the source.
Ops rebuild the target in order.

Tie-breaking (deterministic): when total costs are equal a literal is
preferred over a copy (a copy must strictly lower the cost to be used);
among copy candidates the one with the smaller source offset wins, then
the longer copy.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json

LIT_COST_PER_BYTE = 1
COPY_COST = 2

OP_LIT = "lit"
OP_COPY = "copy"


class PatchError(Exception):
    """Raised when a patch is malformed or fails validation."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _op_key(op: tuple) -> tuple:
    if op[0] == OP_LIT:
        return (0,)
    _, offset, length = op
    return (1, offset, -length)


def compute_ops(source: bytes, target: bytes):
    """Return (ops, cost): a minimal-cost op sequence rebuilding target.

    Each op is ("lit", byte) or ("copy", offset, length).  Dynamic
    programming over target prefixes: for prefix length i the best
    sequence ends either with a literal of target[i-1] or with a copy of
    target[i-length:i], which is only allowed when that slice occurs in
    source.
    """
    n = len(target)
    cost = [0] * (n + 1)
    choice = [None] * (n + 1)
    for i in range(1, n + 1):
        best_op = (OP_LIT, target[i - 1])
        best_pred = i - 1
        best_key = (cost[i - 1] + LIT_COST_PER_BYTE, _op_key(best_op))
        length = 1
        while length <= i:
            offset = source.find(target[i - length:i])
            if offset == -1:
                break
            cand_op = (OP_COPY, offset, length)
            cand_key = (cost[i - length] + COPY_COST, _op_key(cand_op))
            if cand_key < best_key:
                best_key = cand_key
                best_op = cand_op
                best_pred = i - length
            length += 1
        cost[i] = best_key[0]
        choice[i] = (best_op, best_pred)
    ops = []
    i = n
    while i > 0:
        op, pred = choice[i]
        ops.append(op)
        i = pred
    ops.reverse()
    return ops, cost[n]


def ops_cost(ops) -> int:
    total = 0
    for op in ops:
        if op[0] == OP_LIT:
            total += LIT_COST_PER_BYTE
        else:
            total += COPY_COST
    return total


def patch_obj(source: bytes, target: bytes, ops) -> dict:
    json_ops = []
    for op in ops:
        if op[0] == OP_LIT:
            json_ops.append({OP_LIT: base64.b64encode(bytes([op[1]])).decode("ascii")})
        else:
            json_ops.append({OP_COPY: [op[1], op[2]]})
    return {
        "source_sha256": sha256_hex(source),
        "target_sha256": sha256_hex(target),
        "ops": json_ops,
    }


def dumps_patch(source: bytes, target: bytes, ops) -> str:
    return json.dumps(patch_obj(source, target, ops), indent=2) + "\n"


def apply_patch(source: bytes, patch_text: str) -> bytes:
    """Validate patch_text against source and return the rebuilt target.

    Raises PatchError on any problem: invalid JSON, bad structure,
    unknown op type, bad literal encoding/length, out-of-bounds copy,
    or source/target hash mismatch.
    """
    try:
        obj = json.loads(patch_text)
    except json.JSONDecodeError as exc:
        raise PatchError(f"invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise PatchError("patch must be a JSON object")
    source_hash = obj.get("source_sha256")
    target_hash = obj.get("target_sha256")
    if not isinstance(source_hash, str) or not isinstance(target_hash, str):
        raise PatchError("missing or invalid source_sha256/target_sha256")
    ops = obj.get("ops")
    if not isinstance(ops, list):
        raise PatchError("missing or invalid 'ops'")
    if source_hash != sha256_hex(source):
        raise PatchError("source hash mismatch")
    out = bytearray()
    for index, op in enumerate(ops):
        if not isinstance(op, dict) or len(op) != 1:
            raise PatchError(f"op {index}: must have exactly one of 'lit'/'copy'")
        if OP_LIT in op:
            value = op[OP_LIT]
            if not isinstance(value, str):
                raise PatchError(f"op {index}: 'lit' must be a base64 string")
            try:
                data = base64.b64decode(value, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise PatchError(f"op {index}: invalid base64 literal") from exc
            if not data:
                raise PatchError(f"op {index}: empty literal")
            out += data
        elif OP_COPY in op:
            value = op[OP_COPY]
            if (
                not isinstance(value, list)
                or len(value) != 2
                or any(type(item) is not int for item in value)
            ):
                raise PatchError(f"op {index}: 'copy' must be [offset, length]")
            offset, length = value
            if offset < 0 or length < 1 or offset + length > len(source):
                raise PatchError(f"op {index}: copy range out of bounds")
            out += source[offset:offset + length]
        else:
            raise PatchError(f"op {index}: unknown op type")
    result = bytes(out)
    if sha256_hex(result) != target_hash:
        raise PatchError("target hash mismatch")
    return result
