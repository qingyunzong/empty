"""Built-in ``fail_when`` predicate rules.

A case fails when its op sequence matches the rule described by the
``fail_when`` object.  Currently the only built-in rule type is
``"consecutive"``: the case fails iff every element of ``pattern`` matches a
consecutive window of the op sequence.

Pattern element keys:

- ``"name"`` (str, optional): op name must equal it.
- ``"args"`` (object, optional): every key must be present in the op's args
  and JSON-equal to the given value.  A missing key is simply a non-match.
- ``"args_key"`` (str, optional): evaluates ``op["args"][args_key]``.  A
  missing key raises ``KeyError`` -- callers treat predicate exceptions as
  "not failing".  If ``"equals"`` is also present, the looked-up value must
  be JSON-equal to it.

Note the predicate is *not* monotone under deletion: deleting an op can make
a previously non-consecutive pattern become consecutive.  The minimizer only
ever accepts transformations that keep the case failing, and verifies
1-minimality explicitly at the end.
"""


def _match_element(pattern_element, op):
    if "name" in pattern_element and pattern_element["name"] != op["name"]:
        return False
    if "args" in pattern_element:
        op_args = op["args"]
        for key, value in pattern_element["args"].items():
            if key not in op_args or op_args[key] != value:
                return False
    if "args_key" in pattern_element:
        value = op["args"][pattern_element["args_key"]]
        if "equals" in pattern_element and value != pattern_element["equals"]:
            return False
    return True


def case_fails(ops, fail_when):
    """Return True iff ``ops`` satisfies the ``fail_when`` rule.

    May raise (e.g. ``KeyError`` from ``args_key`` lookups); callers are
    expected to treat exceptions as "not failing".
    """
    rule_type = fail_when.get("type")
    if rule_type != "consecutive":
        raise ValueError(f"unsupported fail_when type: {rule_type!r}")
    pattern = fail_when["pattern"]
    size = len(pattern)
    if size == 0 or size > len(ops):
        return False
    for start in range(0, len(ops) - size + 1):
        if all(
            _match_element(pattern[offset], ops[start + offset])
            for offset in range(size)
        ):
            return True
    return False
