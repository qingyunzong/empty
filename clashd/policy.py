"""Policy compilation and deterministic decision making.

Compilation validates the rule set, checks for total ties (E_TIE),
requires an explicit default decision (E_NO_DEFAULT), and pre-sorts
rules into comparable layers ordered by:

  1. priority            (descending)
  2. resource specificity (descending)
  3. rule_id             (ascending, lexicographic)

Decision semantics:
  * A "comparable layer" is a group of rules sharing the same
    (priority, specificity); only rule_id distinguishes them.
  * Layers are consulted in order; the first layer with any matching
    or UNKNOWN rule decides the outcome, lower layers never apply.
  * Within the deciding layer, any definite deny overrides definite
    allows (deny never crosses into a lower layer).
  * If the deciding layer has no definite match but at least one
    UNKNOWN condition, the decision is "unknown".
  * If no layer matches, the configured default applies.
"""

from dataclasses import dataclass

from .conditions import UNKNOWN, eval_condition
from .errors import PolicyError
from .resource import match_resource, specificity

ACTIONS = ("allow", "deny")


@dataclass(frozen=True)
class Rule:
    rule_id: str
    action: str
    priority: int
    resource: str
    conditions: object
    specificity: tuple


def _sort_key(rule):
    return (-rule.priority, tuple(-x for x in rule.specificity), rule.rule_id)


class Policy:
    """A compiled, deterministic decision maker."""

    def __init__(self, default, layers):
        self.default = default
        # layers: list of rule lists, highest (priority, specificity)
        # first; each layer is sorted by rule_id ascending.
        self.layers = layers

    @property
    def rules(self):
        return [rule for layer in self.layers for rule in layer]


def _parse_rule(raw, index):
    if not isinstance(raw, dict):
        raise PolicyError("E_RULE", f"rule #{index} is not an object")
    rule_id = raw.get("rule_id")
    if not isinstance(rule_id, str) or not rule_id:
        raise PolicyError("E_RULE", f"rule #{index}: missing rule_id")
    action = raw.get("action")
    if action not in ACTIONS:
        raise PolicyError("E_RULE", f"rule {rule_id!r}: bad action {action!r}")
    priority = raw.get("priority")
    if not isinstance(priority, int) or isinstance(priority, bool):
        raise PolicyError("E_RULE", f"rule {rule_id!r}: bad priority")
    resource = raw.get("resource")
    if not isinstance(resource, str) or not resource:
        raise PolicyError("E_RULE", f"rule {rule_id!r}: missing resource")
    return Rule(
        rule_id=rule_id,
        action=action,
        priority=priority,
        resource=resource,
        conditions=raw.get("conditions"),
        specificity=specificity(resource),
    )


def compile_policy(config):
    """Compile a rule-set mapping into a Policy.

    Raises PolicyError E_NO_DEFAULT if the default decision is not
    explicitly configured, and E_TIE if two rules are fully tied on
    (priority, specificity, rule_id).
    """
    if not isinstance(config, dict):
        raise PolicyError("E_POLICY", "policy must be a JSON object")
    if "default" not in config:
        raise PolicyError(
            "E_NO_DEFAULT", "policy must configure an explicit default"
        )
    default = config["default"]
    if default not in ACTIONS:
        raise PolicyError(
            "E_INVALID_DEFAULT", f"default must be one of {ACTIONS}"
        )
    raw_rules = config.get("rules", [])
    if not isinstance(raw_rules, list):
        raise PolicyError("E_POLICY", "'rules' must be a list")

    rules = []
    seen = {}
    for index, raw in enumerate(raw_rules):
        rule = _parse_rule(raw, index)
        key = (rule.priority, rule.specificity, rule.rule_id)
        if key in seen:
            raise PolicyError(
                "E_TIE",
                "rules {!r} and {!r} are fully tied on "
                "(priority, specificity, rule_id)".format(seen[key], rule.rule_id),
            )
        seen[key] = rule.rule_id
        rules.append(rule)

    rules.sort(key=_sort_key)
    layers = []
    for rule in rules:
        head = layers[-1][0] if layers else None
        if (head is not None and head.priority == rule.priority
                and head.specificity == rule.specificity):
            layers[-1].append(rule)
        else:
            layers.append([rule])
    return Policy(default=default, layers=layers)


def decide(policy, request):
    """Decide a single request against a compiled Policy.

    Returns a dict with ``decision`` ("allow" | "deny" | "unknown"),
    ``winning_rule`` (rule_id or None) and ``reason``.
    """
    if not isinstance(request, dict):
        raise PolicyError("E_REQUEST", "request must be a JSON object")
    resource = request.get("resource")
    if not isinstance(resource, str) or not resource:
        raise PolicyError("E_REQUEST", "request must name a 'resource'")
    attrs = request.get("attrs", {})
    if not isinstance(attrs, dict):
        raise PolicyError("E_REQUEST", "'attrs' must be an object")

    for layer in policy.layers:
        definite = []
        has_unknown = False
        for rule in layer:
            if not match_resource(rule.resource, resource):
                continue
            verdict = eval_condition(rule.conditions, attrs)
            if verdict is True:
                definite.append(rule)
            elif verdict is UNKNOWN:
                has_unknown = True
        if definite:
            for rule in definite:
                if rule.action == "deny":
                    return {
                        "decision": "deny",
                        "winning_rule": rule.rule_id,
                        "reason": "rule",
                    }
            winner = definite[0]
            return {
                "decision": winner.action,
                "winning_rule": winner.rule_id,
                "reason": "rule",
            }
        if has_unknown:
            return {
                "decision": "unknown",
                "winning_rule": None,
                "reason": "unknown_condition",
            }
    return {
        "decision": policy.default,
        "winning_rule": None,
        "reason": "default",
    }
