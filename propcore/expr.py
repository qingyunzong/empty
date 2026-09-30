"""Evaluation of the property expressions embedded in a spec.

Expressions are evaluated against a single namespace containing the
generated ``value`` plus a whitelist of safe builtins.  The outcome is a
triple-state: ``pass`` / ``fail`` / ``error`` so that exceptions raised
while running a property are treated as failures of a distinct kind
(``ERROR``) from ordinary falsy results (``PROPERTY_FAIL``).
"""

_SAFE_FUNCS = {
    name: obj
    for name, obj in (
        ("abs", abs),
        ("all", all),
        ("any", any),
        ("bool", bool),
        ("dict", dict),
        ("enumerate", enumerate),
        ("float", float),
        ("int", int),
        ("isinstance", isinstance),
        ("len", len),
        ("list", list),
        ("max", max),
        ("min", min),
        ("range", range),
        ("repr", repr),
        ("round", round),
        ("set", set),
        ("sorted", sorted),
        ("str", str),
        ("sum", sum),
        ("tuple", tuple),
        ("zip", zip),
    )
}


def compile_expr(source):
    """Compile a property expression; raises on invalid input."""
    if not isinstance(source, str) or not source.strip():
        raise ValueError("expr must be a non-empty string")
    return compile(source, "<property>", "eval")


def evaluate(code, value):
    """Evaluate a compiled property on ``value``.

    Returns ``(outcome, detail)`` where outcome is one of ``"pass"``,
    ``"fail"`` or ``"error"``; detail carries the exception message for
    ``"error"`` and is ``None`` otherwise.
    """
    namespace = {"__builtins__": {}}
    namespace.update(_SAFE_FUNCS)
    namespace["value"] = value
    try:
        result = eval(code, namespace)
    except Exception as exc:  # noqa: BLE001 - any exception is an ERROR failure
        return ("error", "%s: %s" % (type(exc).__name__, exc))
    return ("pass", None) if result else ("fail", None)
