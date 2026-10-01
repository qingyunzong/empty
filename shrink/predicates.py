"""Built-in ``fail_when`` predicate rules.

A predicate maps a list of ops (dicts with ``name``/``args``) to a bool:
True means "the failure is still present".  Any exception raised while
evaluating a predicate is treated by the minimizer as "not failing".
"""


def _field(spec, key, kinds, kind_name):
    if key not in spec:
        raise ValueError("fail_when rule %r requires field %r" % (spec.get("type"), key))
    value = spec[key]
    if isinstance(value, bool) or not isinstance(value, kinds):
        raise ValueError("fail_when field %r must be %s" % (key, kind_name))
    return value


def build_predicate(spec):
    """Build a predicate callable from a ``fail_when`` spec dict.

    Raises ValueError if the spec is invalid (treated as invalid input).
    """
    if not isinstance(spec, dict):
        raise ValueError("fail_when must be a JSON object")
    rule = spec.get("type")

    if rule == "always":
        return lambda ops: True

    if rule == "never":
        return lambda ops: False

    if rule == "min_length":
        n = _field(spec, "n", int, "an integer")
        if n < 0:
            raise ValueError("fail_when field 'n' must be >= 0")
        return lambda ops: len(ops) >= n

    if rule == "contains_subsequence":
        names = _field(spec, "names", list, "a list of strings")
        if not all(isinstance(x, str) for x in names):
            raise ValueError("fail_when field 'names' must be a list of strings")

        def pred(ops, names=names):
            m = len(names)
            if m == 0:
                return True
            window = [op["name"] for op in ops]
            return any(window[i:i + m] == names for i in range(len(window) - m + 1))

        return pred

    if rule == "args_sum_at_least":
        key = _field(spec, "key", str, "a string")
        threshold = _field(spec, "threshold", (int, float), "a number")

        def pred(ops):
            total = 0
            for op in ops:
                value = op["args"][key]  # KeyError on purpose: treated as not failing
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise TypeError("arg %r is not numeric" % key)
                total += value
            return total >= threshold

        return pred

    raise ValueError("unknown fail_when type: %r" % (rule,))
