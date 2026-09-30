import json
import os
import random
import string
import subprocess
import sys
import tempfile
import unittest

from clashd import PolicyError, decide, load_policy
from clashd.conditions import Tri, eval_condition
from clashd.policy import resource_matches, specificity
from clashd.reference import reference_decide

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_policy(rules, default="deny"):
    obj = {"rules": rules}
    if default is not None:
        obj["default"] = default
    return load_policy(obj)


def req(resource, **attributes):
    return {"resource": resource, "attributes": attributes}


class SpecificityTests(unittest.TestCase):
    def test_more_literals_beat_wildcards(self):
        self.assertGreater(specificity("a/b/c"), specificity("a/*/c"))
        self.assertGreater(specificity("a/b"), specificity("a/*"))
        self.assertGreater(specificity("a/*"), specificity("*/*"))
        self.assertGreater(specificity("a/b"), specificity("**"))

    def test_resource_matching(self):
        self.assertTrue(resource_matches("a/*", "a/b"))
        self.assertFalse(resource_matches("a/*", "a/b/c"))
        self.assertTrue(resource_matches("a/**", "a/b/c"))
        self.assertTrue(resource_matches("**", "a/b/c"))
        self.assertTrue(resource_matches("a/b", "a/b"))
        self.assertFalse(resource_matches("a/b", "a/c"))


class AcceptanceTests(unittest.TestCase):
    def test_a_same_priority_more_specific_wins(self):
        policy = make_policy([
            {"rule_id": "broad", "action": "allow", "priority": 5, "resource": "docs/*"},
            {"rule_id": "narrow", "action": "deny", "priority": 5, "resource": "docs/secret"},
        ])
        result = decide(policy, req("docs/secret"))
        self.assertEqual(result.decision, "deny")
        self.assertEqual(result.winning_rule, "narrow")

    def test_a_more_specific_allow_beats_less_specific_deny(self):
        policy = make_policy([
            {"rule_id": "broad", "action": "deny", "priority": 5, "resource": "docs/*"},
            {"rule_id": "narrow", "action": "allow", "priority": 5, "resource": "docs/secret"},
        ])
        result = decide(policy, req("docs/secret"))
        self.assertEqual(result.decision, "allow")
        self.assertEqual(result.winning_rule, "narrow")

    def test_b_full_tie_is_config_error(self):
        policy = make_policy([
            {"rule_id": "dup", "action": "allow", "priority": 1, "resource": "a/b"},
            {"rule_id": "dup", "action": "allow", "priority": 1, "resource": "a/b"},
        ])
        with self.assertRaises(PolicyError) as ctx:
            decide(policy, req("a/b"))
        self.assertEqual(ctx.exception.code, "E_TIE")

    def test_c_low_priority_deny_does_not_override_high_priority_allow(self):
        policy = make_policy([
            {"rule_id": "hi", "action": "allow", "priority": 10, "resource": "a/b"},
            {"rule_id": "lo", "action": "deny", "priority": 1, "resource": "a/b"},
        ])
        result = decide(policy, req("a/b"))
        self.assertEqual(result.decision, "allow")
        self.assertEqual(result.winning_rule, "hi")

    def test_deny_overrides_allow_within_same_layer(self):
        policy = make_policy([
            {"rule_id": "aaa", "action": "allow", "priority": 5, "resource": "a/b"},
            {"rule_id": "zzz", "action": "deny", "priority": 5, "resource": "a/b"},
        ])
        result = decide(policy, req("a/b"))
        self.assertEqual(result.decision, "deny")
        self.assertEqual(result.winning_rule, "zzz")

    def test_rule_id_breaks_tie_within_same_action(self):
        policy = make_policy([
            {"rule_id": "b", "action": "allow", "priority": 5, "resource": "a/b"},
            {"rule_id": "a", "action": "allow", "priority": 5, "resource": "a/b"},
        ])
        result = decide(policy, req("a/b"))
        self.assertEqual(result.decision, "allow")
        self.assertEqual(result.winning_rule, "a")

    def test_d_unknown_attribute_yields_unknown_not_rejection(self):
        policy = make_policy([
            {"rule_id": "cond", "action": "allow", "priority": 5, "resource": "a/b",
             "conditions": {"attr": "missing", "op": "eq", "value": 1}},
        ])
        result = decide(policy, req("a/b"))
        self.assertEqual(result.decision, "unknown")
        self.assertEqual(result.winning_rule, "cond")

    def test_unknown_is_not_false_and_blocks_lower_layers(self):
        policy = make_policy([
            {"rule_id": "unk", "action": "deny", "priority": 9, "resource": "a/b",
             "conditions": {"attr": "missing", "op": "eq", "value": 1}},
            {"rule_id": "low", "action": "allow", "priority": 1, "resource": "a/b"},
        ])
        result = decide(policy, req("a/b"))
        self.assertEqual(result.decision, "unknown")
        self.assertEqual(result.winning_rule, "unk")

    def test_no_default_raises_e_no_default(self):
        policy = make_policy([
            {"rule_id": "r", "action": "allow", "priority": 1, "resource": "x/y"},
        ], default=None)
        with self.assertRaises(PolicyError) as ctx:
            decide(policy, req("a/b"))
        self.assertEqual(ctx.exception.code, "E_NO_DEFAULT")

    def test_default_used_when_no_match(self):
        policy = make_policy([
            {"rule_id": "r", "action": "allow", "priority": 1, "resource": "x/y"},
        ], default="allow")
        result = decide(policy, req("a/b"))
        self.assertEqual(result.decision, "allow")
        self.assertIsNone(result.winning_rule)


class ConditionTests(unittest.TestCase):
    def test_short_circuit_and(self):
        cond = {"and": [
            {"attr": "x", "op": "eq", "value": 1},
            {"attr": "missing", "op": "eq", "value": 1},
        ]}
        self.assertIs(eval_condition(cond, {"x": 2}), Tri.FALSE)
        self.assertIs(eval_condition(cond, {"x": 1}), Tri.UNKNOWN)

    def test_short_circuit_or(self):
        cond = {"or": [
            {"attr": "x", "op": "eq", "value": 1},
            {"attr": "missing", "op": "eq", "value": 1},
        ]}
        self.assertIs(eval_condition(cond, {"x": 1}), Tri.TRUE)
        self.assertIs(eval_condition(cond, {"x": 2}), Tri.UNKNOWN)

    def test_not_unknown_stays_unknown(self):
        cond = {"not": {"attr": "gone", "op": "eq", "value": 1}}
        self.assertIs(eval_condition(cond, {}), Tri.UNKNOWN)

    def test_unknown_not_equal_false(self):
        cond = {"attr": "gone", "op": "eq", "value": 1}
        self.assertIsNot(eval_condition(cond, {}), Tri.FALSE)
        self.assertNotEqual(eval_condition(cond, {}), Tri.FALSE)

    def test_nested_and_operators(self):
        cond = {"and": [
            {"attr": "age", "op": "ge", "value": 18},
            {"or": [
                {"attr": "role", "op": "in", "value": ["admin", "ops"]},
                {"exists": "token"},
            ]},
        ]}
        self.assertIs(eval_condition(cond, {"age": 20, "role": "admin"}), Tri.TRUE)
        self.assertIs(eval_condition(cond, {"age": 20}), Tri.UNKNOWN)
        self.assertIs(eval_condition(cond, {"age": 10, "role": "admin"}), Tri.FALSE)


def _random_condition(rng, attrs, depth=2):
    if depth == 0 or rng.random() < 0.4:
        kind = rng.choice(["cmp", "exists"])
        if kind == "exists":
            return {"exists": rng.choice(attrs)}
        op = rng.choice(["eq", "ne", "lt", "le", "gt", "ge", "in"])
        if op == "in":
            value = [rng.randint(0, 5) for _ in range(rng.randint(1, 3))]
        else:
            value = rng.randint(0, 5)
        return {"attr": rng.choice(attrs), "op": op, "value": value}
    combiner = rng.choice(["and", "or", "not"])
    if combiner == "not":
        return {"not": _random_condition(rng, attrs, depth - 1)}
    return {combiner: [
        _random_condition(rng, attrs, depth - 1) for _ in range(rng.randint(1, 3))
    ]}


def _random_policy_obj(rng, rule_count):
    segments = ["a", "b", "c"]
    attrs = ["p", "q", "r"]
    rules = []
    for i in range(rule_count):
        pattern = "/".join(
            rng.choice(segments + ["*", "**"]) for _ in range(rng.randint(1, 3))
        )
        rule = {
            "rule_id": f"rule-{i:03d}",
            "action": rng.choice(["allow", "deny"]),
            "priority": rng.choice([0, 1, 1, 2, 2, 2, 3]),
            "resource": pattern,
        }
        if rng.random() < 0.6:
            rule["conditions"] = _random_condition(rng, attrs)
        rules.append(rule)
    obj = {"rules": rules}
    if rng.random() < 0.8:
        obj["default"] = rng.choice(["allow", "deny"])
    return obj


def _random_request(rng):
    segments = ["a", "b", "c"]
    resource = "/".join(rng.choice(segments) for _ in range(rng.randint(1, 3)))
    attributes = {}
    for attr in ["p", "q", "r"]:
        if rng.random() < 0.6:
            attributes[attr] = rng.randint(0, 5)
    return {"resource": resource, "attributes": attributes}


class RandomizedReferenceTests(unittest.TestCase):
    def test_e_matches_reference_implementation(self):
        for seed in range(5):
            rng = random.Random(seed)
            policy_obj = _random_policy_obj(rng, rule_count=rng.randint(1, 30))
            policy = load_policy(policy_obj)
            for _ in range(200):
                request = _random_request(rng)
                try:
                    expected = reference_decide(policy_obj, request)
                    expected_error = None
                except PolicyError as exc:
                    expected = None
                    expected_error = exc.code
                if expected_error is not None:
                    with self.assertRaises(PolicyError) as ctx:
                        decide(policy, request)
                    self.assertEqual(ctx.exception.code, expected_error,
                                     f"seed={seed} request={request}")
                else:
                    result = decide(policy, request)
                    self.assertEqual(result.to_dict(), expected,
                                     f"seed={seed} request={request}")


class CliTests(unittest.TestCase):
    def _run_cli(self, rules_obj, request_obj):
        with tempfile.TemporaryDirectory() as tmp:
            rules_path = os.path.join(tmp, "rules.json")
            req_path = os.path.join(tmp, "req.json")
            with open(rules_path, "w", encoding="utf-8") as fh:
                json.dump(rules_obj, fh)
            with open(req_path, "w", encoding="utf-8") as fh:
                json.dump(request_obj, fh)
            return subprocess.run(
                [sys.executable, "-m", "clashd", "decide", rules_path, req_path],
                capture_output=True, text=True, cwd=REPO_ROOT,
            )

    def test_cli_decide_outputs_json(self):
        rules = {
            "default": "deny",
            "rules": [
                {"rule_id": "r1", "action": "allow", "priority": 3,
                 "resource": "docs/*"},
            ],
        }
        proc = self._run_cli(rules, {"resource": "docs/a", "attributes": {}})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout),
                         {"decision": "allow", "winning_rule": "r1"})

    def test_cli_policy_error_exit_code_2(self):
        rules = {"rules": []}  # no default
        proc = self._run_cli(rules, {"resource": "a", "attributes": {}})
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "E_NO_DEFAULT")

    def test_cli_tie_exit_code_2(self):
        rules = {
            "default": "deny",
            "rules": [
                {"rule_id": "x", "action": "allow", "priority": 1, "resource": "a"},
                {"rule_id": "x", "action": "allow", "priority": 1, "resource": "a"},
            ],
        }
        proc = self._run_cli(rules, {"resource": "a", "attributes": {}})
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "E_TIE")


if __name__ == "__main__":
    unittest.main()
