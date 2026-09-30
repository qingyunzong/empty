"""Policy loading, resource matching, and deterministic decision."""

from dataclasses import dataclass
from typing import Optional

from .conditions import Tri, eval_condition
from .errors import PolicyError

_ACTIONS = ("allow", "deny")


@dataclass(frozen=True)
class Rule:
    rule_id: str
    action: str
    priority: int
    resource: str
    condition: Optional[dict]


@dataclass(frozen=True)
class Policy:
    rules: tuple
    default: Optional[str]


@dataclass(frozen=True)
class Decision:
    decision: str  # "allow" | "deny" | "unknown"
    winning_rule: Optional[str]

    def to_dict(self):
        return {"decision": self.decision, "winning_rule": self.winning_rule}


def resource_matches(pattern, resource):
    """Match a resource against a glob pattern.

    `*` matches exactly one segment, `**` matches zero or more segments.
    """
    return _match_segments(pattern.split("/"), resource.split("/"))


def _match_segments(pat, res):
    if not pat:
        return not res
    head = pat[0]
    if head == "**":
        return _match_segments(pat[1:], res) or (bool(res) and _match_segments(pat, res[1:]))
    if not res:
        return False
    if head == "*" or head == res[0]:
        return _match_segments(pat[1:], res[1:])
    return False


def specificity(pattern):
    """Specificity of a resource pattern; larger tuple is more specific."""
    segments = pattern.split("/")
    literals = [s for s in segments if s not in ("*", "**")]
    return (len(literals), sum(len(s) for s in literals), -len(segments) + len(literals))


def _check_str(obj, key, allow_empty=False):
    value = obj.get(key)
    if not isinstance(value, str) or (not allow_empty and not value):
        raise PolicyError("E_INVALID_RULE", f"rule field {key!r} must be a non-empty string")
    return value


def load_policy(obj):
    if not isinstance(obj, dict):
        raise PolicyError("E_INVALID_POLICY", "policy must be a JSON object")
    default = obj.get("default")
    if default is not None and default not in _ACTIONS:
        raise PolicyError("E_INVALID_POLICY", f"default must be 'allow' or 'deny', got {default!r}")
    raw_rules = obj.get("rules")
    if not isinstance(raw_rules, list):
        raise PolicyError("E_INVALID_POLICY", "policy must contain a 'rules' list")
    rules = []
    for index, raw in enumerate(raw_rules):
        if not isinstance(raw, dict):
            raise PolicyError("E_INVALID_RULE", f"rule #{index} must be an object")
        rule_id = _check_str(raw, "rule_id")
        action = _check_str(raw, "action")
        if action not in _ACTIONS:
            raise PolicyError("E_INVALID_RULE", f"rule {rule_id!r}: action must be allow/deny")
        priority = raw.get("priority", 0)
        if not isinstance(priority, int) or isinstance(priority, bool):
            raise PolicyError("E_INVALID_RULE", f"rule {rule_id!r}: priority must be an integer")
        resource = _check_str(raw, "resource")
        condition = raw.get("conditions")
        if condition is not None and not isinstance(condition, dict):
            raise PolicyError("E_INVALID_RULE", f"rule {rule_id!r}: conditions must be an object")
        rules.append(Rule(rule_id, action, priority, resource, condition))
    return Policy(tuple(rules), default)


def _check_tie(rules):
    """Raise E_TIE if two rules in the winning layer share a rule_id."""
    seen = set()
    for rule in rules:
        if rule.rule_id in seen:
            raise PolicyError(
                "E_TIE",
                f"rules are fully tied on (priority, specificity, rule_id={rule.rule_id!r})",
            )
        seen.add(rule.rule_id)


def decide(policy, request):
    if not isinstance(request, dict):
        raise PolicyError("E_INVALID_REQUEST", "request must be a JSON object")
    resource = request.get("resource")
    if not isinstance(resource, str) or not resource:
        raise PolicyError("E_INVALID_REQUEST", "request must contain a non-empty 'resource' string")
    attributes = request.get("attributes", {})
    if not isinstance(attributes, dict):
        raise PolicyError("E_INVALID_REQUEST", "request 'attributes' must be an object")

    candidates = []  # (rule, Tri) with status TRUE or UNKNOWN
    for rule in policy.rules:
        if not resource_matches(rule.resource, resource):
            continue
        status = eval_condition(rule.condition, attributes)
        if status is Tri.FALSE:
            continue
        candidates.append((rule, status))

    if not candidates:
        if policy.default is None:
            raise PolicyError("E_NO_DEFAULT", "no rule matched and policy has no default")
        return Decision(policy.default, None)

    # Layer 1: highest priority only; lower-priority denies never override.
    best_priority = max(rule.priority for rule, _ in candidates)
    layer = [(r, s) for r, s in candidates if r.priority == best_priority]
    # Layer 2: highest specificity within that priority.
    best_spec = max(specificity(rule.resource) for rule, _ in layer)
    layer = [(r, s) for r, s in layer if specificity(r.resource) == best_spec]

    trues = [rule for rule, status in layer if status is Tri.TRUE]
    if not trues:
        # UNKNOWN is not FALSE: an unknown top layer blocks lower layers.
        _check_tie([rule for rule, _ in layer])
        winner = min(rule.rule_id for rule, _ in layer)
        return Decision("unknown", winner)

    _check_tie(trues)
    # Deny overrides allow only inside this top comparable layer.
    denies = [rule for rule in trues if rule.action == "deny"]
    group = denies if denies else trues
    winner = min(rule.rule_id for rule in group)
    return Decision("deny" if denies else "allow", winner)
