"""Independent reference implementation used by the randomized tests.

Deliberately written as a straightforward scan over raw dicts with
explicit loops, sharing only the condition/matching primitives, so the
conflict-resolution logic of `clashd.policy.decide` is cross-checked
against separately written code.
"""

from .conditions import Tri, eval_condition
from .errors import PolicyError
from .policy import resource_matches, specificity


def reference_decide(policy_obj, request_obj):
    resource = request_obj["resource"]
    attributes = request_obj.get("attributes", {})

    matched = []
    for rule in policy_obj.get("rules", []):
        if not resource_matches(rule["resource"], resource):
            continue
        status = eval_condition(rule.get("conditions"), attributes)
        if status is Tri.FALSE:
            continue
        matched.append((rule, status))

    if not matched:
        default = policy_obj.get("default")
        if default is None:
            raise PolicyError("E_NO_DEFAULT", "no rule matched and policy has no default")
        return {"decision": default, "winning_rule": None}

    best_priority = matched[0][0].get("priority", 0)
    for rule, _ in matched[1:]:
        priority = rule.get("priority", 0)
        if priority > best_priority:
            best_priority = priority
    layer = [(r, s) for r, s in matched if r.get("priority", 0) == best_priority]

    best_spec = specificity(layer[0][0]["resource"])
    for rule, _ in layer[1:]:
        spec = specificity(rule["resource"])
        if spec > best_spec:
            best_spec = spec
    layer = [(r, s) for r, s in layer if specificity(r["resource"]) == best_spec]

    trues = [rule for rule, status in layer if status is Tri.TRUE]

    if not trues:
        ids = []
        for rule, _ in layer:
            if rule["rule_id"] in ids:
                raise PolicyError("E_TIE", f"duplicate rule_id {rule['rule_id']!r} in top layer")
            ids.append(rule["rule_id"])
        winner = ids[0]
        for rule_id in ids[1:]:
            if rule_id < winner:
                winner = rule_id
        return {"decision": "unknown", "winning_rule": winner}

    ids = []
    for rule in trues:
        if rule["rule_id"] in ids:
            raise PolicyError("E_TIE", f"duplicate rule_id {rule['rule_id']!r} in top layer")
        ids.append(rule["rule_id"])

    denies = [rule for rule in trues if rule["action"] == "deny"]
    group = denies if denies else trues
    winner = group[0]["rule_id"]
    for rule in group[1:]:
        if rule["rule_id"] < winner:
            winner = rule["rule_id"]
    return {"decision": "deny" if denies else "allow", "winning_rule": winner}
