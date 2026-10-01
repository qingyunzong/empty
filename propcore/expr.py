"""Safe-ish evaluation of property expressions embedded in the spec."""

SAFE_FUNCS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "range": range,
    "reversed": reversed,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
}


def compile_expr(expr, name):
    """Compile an expression; raises SyntaxError on invalid input."""
    return compile(expr, "<property:%s>" % name, "eval")


def evaluate(prop, value):
    """Evaluate a property against value. Exceptions propagate to caller."""
    fn = prop.get("fn")
    if fn is not None:
        return fn(value)
    env = dict(SAFE_FUNCS)
    env["value"] = value
    return eval(prop["code"], {"__builtins__": {}}, env)
