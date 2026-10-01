"""Loading and validation of test specs."""

import json
import os

from .expr import compile_expr
from .generators import SpecError, normalize_gen


def normalize_property(raw, index):
    if not isinstance(raw, dict):
        raise SpecError("property #%d must be an object" % index)
    name = raw.get("name", "prop%d" % index)
    if not isinstance(name, str):
        raise SpecError("property name must be a string")
    if "gen" not in raw:
        raise SpecError("property %r requires 'gen'" % name)
    gen = normalize_gen(raw["gen"])
    expr = raw.get("expr")
    fn = raw.get("fn")
    if expr is None and fn is None:
        raise SpecError("property %r requires 'expr'" % name)
    if expr is not None and fn is not None:
        raise SpecError("property %r: use either 'expr' or 'fn', not both" % name)
    code = None
    if expr is not None:
        if not isinstance(expr, str):
            raise SpecError("property %r: 'expr' must be a string" % name)
        try:
            code = compile_expr(expr, name)
        except SyntaxError as exc:
            raise SpecError("property %r: invalid expression: %s" % (name, exc))
    if fn is not None and not callable(fn):
        raise SpecError("property %r: 'fn' must be callable" % name)
    return {"name": name, "gen": gen, "expr": expr, "fn": fn, "code": code}


def load_spec(obj):
    """Normalize a spec (dict with 'properties', or a single property)."""
    if not isinstance(obj, dict):
        raise SpecError("spec must be a JSON object")
    if "properties" in obj:
        raw_props = obj["properties"]
        if not isinstance(raw_props, list) or not raw_props:
            raise SpecError("'properties' must be a non-empty list")
    elif "gen" in obj:
        raw_props = [obj]
    else:
        raise SpecError("spec must contain 'properties' or a single property")
    return {
        "properties": [normalize_property(p, i) for i, p in enumerate(raw_props)]
    }


def load_spec_file(path):
    if not os.path.exists(path):
        raise SpecError("spec file not found: %s" % path)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            obj = json.load(fh)
    except (OSError, ValueError) as exc:
        raise SpecError("cannot parse spec file %s: %s" % (path, exc))
    return load_spec(obj)
