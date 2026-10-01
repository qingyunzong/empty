"""Core logic for the delta/patch binary diff tools.

Patch format (JSON)::

    {
      "source_sha256": "<hex>",
      "target_sha256": "<hex>",
      "ops": [ {"lit": "<base64>"} | {"copy": [offset, length]}, ... ]
    }

Cost model: one literal byte costs 1, one copy op costs a flat 2.
"""

import base64
import binascii
import hashlib

COPY_COST = 2


class PatchError(Exception):
    """Raised when a patch document is invalid or fails verification."""


def compute_ops(source, target):
    """Return (ops, cost): the minimum-cost op sequence rebuilding target.

    ops is a list of ("lit", bytes) and ("copy", offset, length) tuples.
    Tie-breaking (deterministic): a literal is kept over an equal-cost copy;
    among equal-cost copies the one with the smaller source offset wins,
    then the longer copy wins.
    """
    n = len(target)
    inf = float("inf")
    dp = [inf] * (n + 1)
    dp[0] = 0
    choice = [None] * (n + 1)
    for i in range(1, n + 1):
        best_cost = dp[i - 1] + 1
        best = ("lit",)
        best_key = None  # (offset, -length) for copies; None means literal
        for length in range(1, i + 1):
            j = i - length
            offset = source.find(target[j:i])
            if offset < 0:
                continue
            cost = dp[j] + COPY_COST
            key = (offset, -length)
            if cost < best_cost or (
                cost == best_cost and best_key is not None and key < best_key
            ):
                best_cost = cost
                best = ("copy", j, offset, length)
                best_key = key
        dp[i] = best_cost
        choice[i] = best

    ops = []
    i = n
    while i > 0:
        step = choice[i]
        if step[0] == "lit":
            ops.append(("lit", target[i - 1 : i]))
            i -= 1
        else:
            _, j, offset, length = step
            ops.append(("copy", offset, length))
            i = j
    ops.reverse()

    merged = []
    for op in ops:
        if op[0] == "lit" and merged and merged[-1][0] == "lit":
            merged[-1] = ("lit", merged[-1][1] + op[1])
        else:
            merged.append(op)
    return merged, dp[n]


def make_patch(source, target):
    """Build the JSON-serialisable patch document for source -> target."""
    ops, _cost = compute_ops(source, target)
    json_ops = []
    for op in ops:
        if op[0] == "lit":
            json_ops.append({"lit": base64.b64encode(op[1]).decode("ascii")})
        else:
            json_ops.append({"copy": [op[1], op[2]]})
    return {
        "source_sha256": hashlib.sha256(source).hexdigest(),
        "target_sha256": hashlib.sha256(target).hexdigest(),
        "ops": json_ops,
    }


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def apply_patch(source, patch):
    """Validate patch against source and return the rebuilt target bytes.

    Raises PatchError on any validation or verification failure.
    """
    if not isinstance(patch, dict):
        raise PatchError("patch must be a JSON object")
    for key in ("source_sha256", "target_sha256", "ops"):
        if key not in patch:
            raise PatchError("missing key: %s" % key)
    source_hash = patch["source_sha256"]
    target_hash = patch["target_sha256"]
    ops = patch["ops"]
    if not isinstance(source_hash, str) or not isinstance(target_hash, str):
        raise PatchError("hashes must be strings")
    if hashlib.sha256(source).hexdigest() != source_hash:
        raise PatchError("source hash mismatch")
    if not isinstance(ops, list):
        raise PatchError("ops must be a list")

    out = bytearray()
    for op in ops:
        if not isinstance(op, dict) or len(op) != 1:
            raise PatchError("op must be an object with exactly one key")
        if "lit" in op:
            value = op["lit"]
            if not isinstance(value, str):
                raise PatchError("lit value must be a base64 string")
            try:
                data = base64.b64decode(value, validate=True)
            except (binascii.Error, ValueError):
                raise PatchError("invalid base64 in lit op")
            out += data
        elif "copy" in op:
            value = op["copy"]
            if (
                not isinstance(value, list)
                or len(value) != 2
                or not all(_is_int(item) for item in value)
            ):
                raise PatchError("copy value must be [offset, length]")
            offset, length = value
            if offset < 0 or length < 1 or offset + length > len(source):
                raise PatchError("copy range out of bounds")
            out += source[offset : offset + length]
        else:
            raise PatchError("unknown op type")

    if hashlib.sha256(bytes(out)).hexdigest() != target_hash:
        raise PatchError("target hash mismatch")
    return bytes(out)
