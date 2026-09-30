"""Loading and validation of property-test specifications."""

import json

from .expr import compile_expr

_GENERATOR_TYPES = ("int", "list", "dict", "oneof")


class SpecError(ValueError):
    """Raised when a spec is invalid; the CLI maps this to exit code 2."""


def load_spec(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except OSError as exc:
        raise SpecError("cannot read spec %r: %s" % (path, exc)) from exc
    except json.JSONDecodeError as exc:
        raise SpecError("spec %r is not valid JSON: %s" % (path, exc)) from exc
    return validate_spec(raw)


def validate_spec(raw):
    if not isinstance(raw, dict):
        raise SpecError("spec must be a JSON object")
    properties = raw.get("properties")
    if not isinstance(properties, list) or not properties:
        raise SpecError("spec must contain a non-empty 'properties' list")
    seen_names = set()
    for index, prop in enumerate(properties):
        where = "properties[%d]" % index
        if not isinstance(prop, dict):
            raise SpecError("%s must be an object" % where)
        name = prop.get("name")
        if not isinstance(name, str) or not name:
            raise SpecError("%s.name must be a non-empty string" % where)
        if name in seen_names:
            raise SpecError("duplicate property name %r" % name)
        seen_names.add(name)
        if "gen" not in prop:
            raise SpecError("%s.gen is required" % where)
        _validate_gen(prop["gen"], "%s.gen" % where)
        source = prop.get("expr")
        try:
            compile_expr(source)
        except (ValueError, SyntaxError) as exc:
            raise SpecError("%s.expr is invalid: %s" % (where, exc)) from exc
    return raw


def _is_int(obj):
    return isinstance(obj, int) and not isinstance(obj, bool)


def _validate_gen(gen, where):
    if not isinstance(gen, dict):
        raise SpecError("%s must be an object" % where)
    gtype = gen.get("type")
    if gtype not in _GENERATOR_TYPES:
        raise SpecError(
            "%s.type must be one of %s, got %r" % (where, list(_GENERATOR_TYPES), gtype)
        )
    if gtype == "int":
        low, high = gen.get("min"), gen.get("max")
        if not _is_int(low) or not _is_int(high):
            raise SpecError("%s.min and %s.max must be integers" % (where, where))
        if low > high:
            raise SpecError("%s.min must be <= %s.max" % (where, where))
    elif gtype == "list":
        if "of" not in gen:
            raise SpecError("%s.of is required" % where)
        min_len = gen.get("min_len", 0)
        max_len = gen.get("max_len")
        if not _is_int(min_len) or min_len < 0:
            raise SpecError("%s.min_len must be a non-negative integer" % where)
        if not _is_int(max_len) or max_len < min_len:
            raise SpecError("%s.max_len must be an integer >= min_len" % where)
        _validate_gen(gen["of"], "%s.of" % where)
    elif gtype == "dict":
        fields = gen.get("fields")
        if not isinstance(fields, dict):
            raise SpecError("%s.fields must be an object" % where)
        for name, sub in fields.items():
            if not isinstance(name, str):
                raise SpecError("%s.fields keys must be strings" % where)
            _validate_gen(sub, "%s.fields[%r]" % (where, name))
    elif gtype == "oneof":
        options = gen.get("options")
        if not isinstance(options, list) or not options:
            raise SpecError("%s.options must be a non-empty list" % where)
        for index, option in enumerate(options):
            _validate_gen(option, "%s.options[%d]" % (where, index))
