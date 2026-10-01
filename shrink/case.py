"""Case file parsing and validation."""

from .predicates import build_predicate


class CaseError(ValueError):
    """Raised when the case file is structurally invalid."""


def parse_case(data):
    """Validate a parsed JSON case document.

    Returns (ops, predicate) where each op is a dict with keys
    ``name`` (str), ``args`` (dict) and ``candidates`` (list of dicts).
    """
    if not isinstance(data, dict):
        raise CaseError("case must be a JSON object")
    ops = data.get("ops")
    if not isinstance(ops, list):
        raise CaseError("case field 'ops' must be a list")
    normalized = []
    for index, op in enumerate(ops):
        where = "ops[%d]" % index
        if not isinstance(op, dict):
            raise CaseError("%s must be an object" % where)
        name = op.get("name")
        if not isinstance(name, str):
            raise CaseError("%s.name must be a string" % where)
        args = op.get("args", {})
        if not isinstance(args, dict):
            raise CaseError("%s.args must be an object" % where)
        candidates = op.get("candidates", [])
        if not isinstance(candidates, list) or not all(isinstance(c, dict) for c in candidates):
            raise CaseError("%s.candidates must be a list of objects" % where)
        normalized.append({"name": name, "args": args, "candidates": candidates})
    if "fail_when" not in data:
        raise CaseError("case is missing required field 'fail_when'")
    try:
        predicate = build_predicate(data["fail_when"])
    except ValueError as exc:
        raise CaseError(str(exc))
    return normalized, predicate
