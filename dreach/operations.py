import json

from .engine import Engine, UnknownSavepointError


class OperationFormatError(ValueError):
    """Raised for malformed operation JSON."""


def execute_operations(operations):
    engine = Engine()
    results = []
    for operation in operations:
        kind = operation["op"]
        if kind == "init":
            engine.init(operation["n"])
            results.append({"op": kind, "result": None})
        elif kind == "insert":
            engine.insert(operation["u"], operation["v"])
            results.append({"op": kind, "result": None})
        elif kind == "delete":
            engine.delete(operation["u"], operation["v"])
            results.append({"op": kind, "result": None})
        elif kind == "savepoint":
            results.append({"op": kind, "result": engine.savepoint()})
        elif kind == "rollback":
            engine.rollback(operation["savepoint"])
            results.append({"op": kind, "result": None})
        elif kind == "reachable":
            result = engine.reachable(operation["u"], operation["v"])
            results.append({"op": kind, "result": result})
        elif kind == "witness":
            results.append({"op": kind, "result": engine.witness(operation["u"], operation["v"])})
    return results


def load_operations(text):
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise OperationFormatError(f"invalid JSON: {exc.msg}") from exc

    if not isinstance(data, list):
        raise OperationFormatError("top-level JSON value must be an operation list")

    return [parse_operation(item) for item in data]


def parse_operation(item):
    if not isinstance(item, dict):
        raise OperationFormatError("each operation must be an object")

    op = item.get("op")
    if not isinstance(op, str):
        raise OperationFormatError("operation must contain a string op field")

    allowed_fields = {
        "init": {"op", "n"},
        "insert": {"op", "u", "v"},
        "delete": {"op", "u", "v"},
        "savepoint": {"op"},
        "rollback": {"op", "savepoint"},
        "reachable": {"op", "u", "v"},
        "witness": {"op", "u", "v"},
    }
    if op not in allowed_fields:
        raise OperationFormatError(f"unknown operation: {op}")

    expected_fields = allowed_fields[op]
    if set(item) != expected_fields:
        raise OperationFormatError(f"invalid fields for {op}")

    operation = dict(item)
    if op == "init":
        _require_integer(operation["n"], "n")
    elif op == "rollback":
        _require_integer(operation["savepoint"], "savepoint")
    elif op in {"insert", "delete", "reachable", "witness"}:
        _require_integer(operation["u"], "u")
        _require_integer(operation["v"], "v")

    return operation


def _require_integer(value, name):
    if not isinstance(value, int) or isinstance(value, bool):
        raise OperationFormatError(f"{name} must be an integer")


def run_json(text):
    operations = load_operations(text)
    try:
        return execute_operations(operations)
    except UnknownSavepointError:
        raise
    except (TypeError, ValueError, RuntimeError) as exc:
        raise OperationFormatError(str(exc)) from exc
