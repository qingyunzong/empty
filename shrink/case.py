"""Validation and normalization of case files."""

from .errors import CaseError


def _validate_pattern_element(index, element):
    if not isinstance(element, dict):
        raise CaseError(f"fail_when.pattern[{index}] must be an object")
    if "name" in element and not isinstance(element["name"], str):
        raise CaseError(f"fail_when.pattern[{index}].name must be a string")
    if "args" in element and not isinstance(element["args"], dict):
        raise CaseError(f"fail_when.pattern[{index}].args must be an object")
    if "args_key" in element and not isinstance(element["args_key"], str):
        raise CaseError(f"fail_when.pattern[{index}].args_key must be a string")


def validate_case(data):
    """Validate raw parsed JSON and return a normalized case dict.

    Raises CaseError on any invalid input.
    """
    if not isinstance(data, dict):
        raise CaseError("case must be a JSON object")

    ops = data.get("ops")
    if not isinstance(ops, list):
        raise CaseError('"ops" must be a list')
    normalized_ops = []
    for index, op in enumerate(ops):
        if not isinstance(op, dict):
            raise CaseError(f"ops[{index}] must be an object")
        name = op.get("name")
        if not isinstance(name, str):
            raise CaseError(f"ops[{index}].name must be a string")
        args = op.get("args", {})
        if not isinstance(args, dict):
            raise CaseError(f"ops[{index}].args must be an object")
        normalized_ops.append({"name": name, "args": args})

    fail_when = data.get("fail_when")
    if not isinstance(fail_when, dict):
        raise CaseError('"fail_when" must be an object')
    if fail_when.get("type") != "consecutive":
        raise CaseError('fail_when.type must be "consecutive"')
    pattern = fail_when.get("pattern")
    if not isinstance(pattern, list) or not pattern:
        raise CaseError("fail_when.pattern must be a non-empty list")
    for index, element in enumerate(pattern):
        _validate_pattern_element(index, element)

    arg_candidates = data.get("arg_candidates", {})
    if not isinstance(arg_candidates, dict):
        raise CaseError('"arg_candidates" must be an object')
    for name, candidates in arg_candidates.items():
        if not isinstance(candidates, list) or not all(
            isinstance(candidate, dict) for candidate in candidates
        ):
            raise CaseError(f'arg_candidates["{name}"] must be a list of objects')

    return {
        "ops": normalized_ops,
        "fail_when": fail_when,
        "arg_candidates": arg_candidates,
    }
