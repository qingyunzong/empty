import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from clashd import (
    PolicyError,
    UNKNOWN,
    compile_policy,
    decide,
    eval_condition,
    match_resource,
    specificity,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def reference_decide(config, request):
    """Naive reference: scans every rule for every request.

    Written independently of clashd.policy.decide; shares only the
    low-level primitives (specificity, match_resource,
    eval_condition).
    """
    if "default" not in config:
        raise PolicyError("E_NO_DEFAULT", "no default configured")
    rules = []
    seen = set()
    for raw in config["rules"]:
        spec = specificity(raw["resource"])
        key = (raw["priority"], spec, raw["rule_id"])
        if key in seen:
            raise PolicyError("E_TIE", "full tie")
        seen.add(key)
        rules.append((raw, spec))

    resource = request["resource"]
    attrs = request.get("attrs", {})

    matched = []
    for raw, spec in rules:
        if not match_resource(raw["resource"], resource):
            continue
        verdict = eval_condition(raw.get("conditions"), attrs)
        if verdict is False:
            continue
        matched.append((raw, spec, verdict))

    if not matched:
        return {
            "decision": config["default"],
            "winning_rule": None,
            "reason": "default",
        }

    # Highest comparable layer: max priority, then max specificity.
    top_priority = max(entry[0]["priority"] for entry in matched)
    matched = [e for e in matched if e[0]["priority"] == top_priority]
    top_spec = max(entry[1] for entry in matched)
    layer = [e for e in matched if e[1] == top_spec]

    definite = [entry for entry in layer if entry[2] is True]
    if not definite:
        return {
            "decision": "unknown",
            "winning_rule": None,
            "reason": "unknown_condition",
        }
    definite.sort(key=lambda entry: entry[0]["rule_id"])
    denies = [entry for entry in definite if entry[0]["action"] == "deny"]
    winner = denies[0] if denies else definite[0]
    return {
        "decision": winner[0]["action"],
        "winning_rule": winner[0]["rule_id"],
        "reason": "rule",
    }


class AcceptanceTests(unittest.TestCase):
    def test_a_same_priority_more_specific_wins(self):
        config = {
            "default": "deny",
            "rules": [
                {"rule_id": "broad", "action": "deny", "priority": 5,
                 "resource": "db/*"},
                {"rule_id": "narrow", "action": "allow", "priority": 5,
                 "resource": "db/users"},
            ],
        }
        result = decide(compile_policy(config), {"resource": "db/users"})
        self.assertEqual(result["decision"], "allow")
        self.assertEqual(result["winning_rule"], "narrow")

    def test_b_full_tie_is_config_error(self):
        config = {
            "default": "deny",
            "rules": [
                {"rule_id": "dup", "action": "allow", "priority": 1,
                 "resource": "a/b"},
                {"rule_id": "dup", "action": "deny", "priority": 1,
                 "resource": "a/b"},
            ],
        }
        with self.assertRaises(PolicyError) as ctx:
            compile_policy(config)
        self.assertEqual(ctx.exception.code, "E_TIE")

    def test_c_lower_priority_deny_does_not_override(self):
        config = {
            "default": "deny",
            "rules": [
                {"rule_id": "hi-allow", "action": "allow", "priority": 10,
                 "resource": "svc/*"},
                {"rule_id": "lo-deny", "action": "deny", "priority": 1,
                 "resource": "svc/*"},
            ],
        }
        result = decide(compile_policy(config), {"resource": "svc/x"})
        self.assertEqual(result["decision"], "allow")
        self.assertEqual(result["winning_rule"], "hi-allow")

    def test_d_unknown_attribute_yields_unknown_not_deny(self):
        config = {
            "default": "deny",
            "rules": [
                {"rule_id": "cond", "action": "allow", "priority": 5,
                 "resource": "res",
                 "conditions": {"eq": ["department", "eng"]}},
            ],
        }
        result = decide(compile_policy(config), {"resource": "res"})
        self.assertEqual(result["decision"], "unknown")
        self.assertIsNone(result["winning_rule"])
        self.assertNotEqual(result["decision"], "deny")

    def test_e_random_requests_match_reference(self):
        rng = random.Random(20260930)
        segments = ["api", "db", "users", "admin", "v1", "logs"]

        def random_pattern():
            parts = []
            for _ in range(rng.randint(1, 3)):
                roll = rng.random()
                if roll < 0.55:
                    parts.append(rng.choice(segments))
                elif roll < 0.8:
                    parts.append("*")
                elif roll < 0.9:
                    parts.append(rng.choice(segments)[:2] + "*")
                else:
                    parts.append("**")
            return "/".join(parts)

        def random_condition(depth=0):
            roll = rng.random()
            if depth >= 2 or roll < 0.35:
                return None
            if roll < 0.55:
                return {"eq": [rng.choice(["role", "dept", "missing"]),
                               rng.choice(["admin", "eng", "ops"])]}
            if roll < 0.65:
                return {"gt": [rng.choice(["level", "clearance"]),
                               rng.randint(1, 5)]}
            if roll < 0.72:
                return {"exists": rng.choice(["token", "badge"])}
            if roll < 0.82:
                return {"in": ["dept", ["eng", "ops"]]}
            if roll < 0.9:
                return {"not": random_condition(depth + 1) or
                        {"eq": ["role", "admin"]}}
            op = rng.choice(["all", "any"])
            subs = [random_condition(depth + 1) or {"exists": "token"}
                    for _ in range(2)]
            return {op: subs}

        rules = []
        for i in range(30):
            rules.append({
                "rule_id": f"rule-{i:02d}",
                "action": rng.choice(["allow", "deny"]),
                "priority": rng.randint(0, 4),
                "resource": random_pattern(),
                "conditions": random_condition(),
            })
        config = {"default": rng.choice(["allow", "deny"]), "rules": rules}

        requests = []
        for _ in range(200):
            resource = "/".join(rng.choice(segments)
                                for _ in range(rng.randint(1, 3)))
            attrs = {}
            if rng.random() < 0.7:
                attrs["role"] = rng.choice(["admin", "eng", "ops"])
            if rng.random() < 0.5:
                attrs["dept"] = rng.choice(["eng", "ops", "sales"])
            if rng.random() < 0.5:
                attrs["level"] = rng.randint(0, 6)
            if rng.random() < 0.3:
                attrs["token"] = True
            requests.append({"resource": resource, "attrs": attrs})

        policy = compile_policy(config)
        for request in requests:
            expected = reference_decide(config, request)
            actual = decide(policy, request)
            self.assertEqual(actual, expected, f"request={request}")


class SemanticsTests(unittest.TestCase):
    def test_missing_default_raises_e_no_default(self):
        with self.assertRaises(PolicyError) as ctx:
            compile_policy({"rules": []})
        self.assertEqual(ctx.exception.code, "E_NO_DEFAULT")

    def test_default_applies_when_nothing_matches(self):
        config = {
            "default": "allow",
            "rules": [{"rule_id": "r", "action": "deny", "priority": 1,
                       "resource": "a"}],
        }
        result = decide(compile_policy(config), {"resource": "zzz"})
        self.assertEqual(result["decision"], "allow")
        self.assertIsNone(result["winning_rule"])
        self.assertEqual(result["reason"], "default")

    def test_deny_overrides_allow_within_same_layer(self):
        config = {
            "default": "allow",
            "rules": [
                {"rule_id": "a-allow", "action": "allow", "priority": 3,
                 "resource": "x"},
                {"rule_id": "z-deny", "action": "deny", "priority": 3,
                 "resource": "x"},
            ],
        }
        result = decide(compile_policy(config), {"resource": "x"})
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["winning_rule"], "z-deny")

    def test_rule_id_breaks_remaining_ties(self):
        config = {
            "default": "deny",
            "rules": [
                {"rule_id": "beta", "action": "allow", "priority": 1,
                 "resource": "x"},
                {"rule_id": "alpha", "action": "allow", "priority": 1,
                 "resource": "x"},
            ],
        }
        result = decide(compile_policy(config), {"resource": "x"})
        self.assertEqual(result["winning_rule"], "alpha")

    def test_unknown_is_not_false(self):
        self.assertIsNot(UNKNOWN, False)
        self.assertNotEqual(UNKNOWN, False)
        self.assertIs(eval_condition({"eq": ["nope", 1]}, {}), UNKNOWN)
        self.assertIs(
            eval_condition({"not": {"eq": ["nope", 1]}}, {}), UNKNOWN)
        self.assertIs(
            eval_condition({"all": [{"eq": ["nope", 1]},
                                    {"exists": "x"}]}, {"x": 1}), UNKNOWN)
        self.assertIs(
            eval_condition({"any": [{"eq": ["nope", 1]}]}, {}), UNKNOWN)

    def test_short_circuit(self):
        self.assertFalse(eval_condition(
            {"all": [{"eq": ["a", 1]}, {"eq": ["nope", 2]}]}, {"a": 2}))
        self.assertTrue(eval_condition(
            {"any": [{"eq": ["a", 1]}, {"eq": ["nope", 2]}]}, {"a": 1}))

    def test_double_star_matches_multiple_segments(self):
        self.assertTrue(match_resource("a/**", "a/b/c"))
        self.assertTrue(match_resource("a/**", "a"))
        self.assertFalse(match_resource("a/*", "a/b/c"))
        self.assertTrue(match_resource("a/us*", "a/users"))

    def test_specificity_orders_exact_above_wildcard(self):
        self.assertGreater(specificity("db/users"), specificity("db/*"))
        self.assertGreater(specificity("db/us*"), specificity("db/*"))


class CliTests(unittest.TestCase):
    def run_cli(self, rules, request):
        with tempfile.TemporaryDirectory() as tmp:
            rules_path = Path(tmp, "rules.json")
            req_path = Path(tmp, "req.json")
            rules_path.write_text(json.dumps(rules))
            req_path.write_text(json.dumps(request))
            return subprocess.run(
                [sys.executable, "-m", "clashd", "decide",
                 str(rules_path), str(req_path)],
                cwd=REPO_ROOT, capture_output=True, text=True)

    def test_cli_outputs_json(self):
        proc = self.run_cli(
            {"default": "deny",
             "rules": [{"rule_id": "r1", "action": "allow", "priority": 1,
                        "resource": "x"}]},
            {"resource": "x"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["decision"], "allow")
        self.assertEqual(out["winning_rule"], "r1")

    def test_cli_policy_error_exit_code_2(self):
        proc = self.run_cli({"rules": []}, {"resource": "x"})
        self.assertEqual(proc.returncode, 2)
        err = json.loads(proc.stderr)
        self.assertEqual(err["error"]["code"], "E_NO_DEFAULT")

    def test_cli_tie_error_exit_code_2(self):
        rules = {"default": "deny", "rules": [
            {"rule_id": "d", "action": "allow", "priority": 1,
             "resource": "x"},
            {"rule_id": "d", "action": "deny", "priority": 1,
             "resource": "x"},
        ]}
        proc = self.run_cli(rules, {"resource": "x"})
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["error"]["code"], "E_TIE")


if __name__ == "__main__":
    unittest.main()
