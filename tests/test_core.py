import unittest

from rbacx import Policy, PolicyError, load_policy


def make_policy(db):
    import json

    return load_policy(json.dumps(db))


class TestDiamondRevocation(unittest.TestCase):
    """Acceptance A: diamond inheritance keeps the permission after one edge
    (or one side-role) is revoked."""

    def diamond(self, revocations):
        return make_policy(
            {
                "roles": {
                    "top": {"inherits": ["left", "right"]},
                    "left": {"inherits": ["base"]},
                    "right": {"inherits": ["base"]},
                    "base": {"allow": ["read"]},
                },
                "users": {"alice": ["top"]},
                "revocations": revocations,
            }
        )

    def test_no_revocation_allows(self):
        result = self.diamond([]).check("alice", "read")
        self.assertEqual(result["decision"], "allow")
        self.assertEqual(result["sources"]["allow"], ["base"])
        self.assertEqual(result["epoch"], 0)

    def test_revoke_one_edge_keeps_permission(self):
        policy = self.diamond([{"epoch": 1, "type": "edge", "role": "top", "target": "left"}])
        result = policy.check("alice", "read")
        self.assertEqual(result["decision"], "allow")
        self.assertEqual(result["sources"]["allow"], ["base"])
        self.assertEqual(result["epoch"], 1)

    def test_revoke_one_side_role_keeps_permission(self):
        policy = self.diamond([{"epoch": 1, "type": "role", "role": "left"}])
        self.assertEqual(policy.check("alice", "read")["decision"], "allow")

    def test_revoke_both_paths_removes_permission(self):
        policy = self.diamond(
            [
                {"epoch": 1, "type": "edge", "role": "top", "target": "left"},
                {"epoch": 2, "type": "edge", "role": "top", "target": "right"},
            ]
        )
        result = policy.check("alice", "read")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["sources"], {"allow": [], "deny": []})
        self.assertEqual(result["epoch"], 2)


class TestCyclicInheritance(unittest.TestCase):
    """Acceptance B: cycles do not loop forever, with or without revocations."""

    def cyclic(self, revocations):
        return make_policy(
            {
                "roles": {
                    "a": {"inherits": ["b"]},
                    "b": {"inherits": ["c"]},
                    "c": {"inherits": ["a"], "allow": ["p"]},
                },
                "users": {"u": ["a"]},
                "revocations": revocations,
            }
        )

    def test_cycle_terminates_and_propagates(self):
        result = self.cyclic([]).check("u", "p")
        self.assertEqual(result["decision"], "allow")
        self.assertEqual(result["sources"]["allow"], ["c"])

    def test_revoke_inside_cycle_terminates(self):
        policy = self.cyclic([{"epoch": 5, "type": "role", "role": "b"}])
        result = policy.check("u", "p")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["sources"], {"allow": [], "deny": []})
        self.assertEqual(result["epoch"], 5)

    def test_self_loop(self):
        policy = make_policy(
            {
                "roles": {"x": {"inherits": ["x"], "allow": ["p"]}},
                "users": {"u": ["x"]},
            }
        )
        self.assertEqual(policy.check("u", "p")["decision"], "allow")


class TestDenyOverrides(unittest.TestCase):
    """Acceptance C: one explicit deny beats many allows."""

    def test_deny_overrides_multiple_allows(self):
        policy = make_policy(
            {
                "roles": {
                    "r1": {"allow": ["p"]},
                    "r2": {"allow": ["p"]},
                    "r3": {"allow": ["p"], "deny": ["p"]},
                },
                "users": {"u": ["r1", "r2", "r3"]},
            }
        )
        result = policy.check("u", "p")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["sources"]["allow"], ["r1", "r2", "r3"])
        self.assertEqual(result["sources"]["deny"], ["r3"])

    def test_inherited_deny_overrides(self):
        policy = make_policy(
            {
                "roles": {
                    "admin": {"inherits": ["restricted"], "allow": ["p"]},
                    "restricted": {"deny": ["p"]},
                },
                "users": {"u": ["admin"]},
            }
        )
        self.assertEqual(policy.check("u", "p")["decision"], "deny")

    def test_revoked_deny_restores_allow(self):
        policy = make_policy(
            {
                "roles": {"r": {"allow": ["p"], "deny": ["p"]}},
                "users": {"u": ["r"]},
                "revocations": [{"epoch": 1, "type": "deny", "role": "r", "perm": "p"}],
            }
        )
        self.assertEqual(policy.check("u", "p")["decision"], "allow")


class TestEmptyAndUndetermined(unittest.TestCase):
    """Acceptance D + rule 5: empty DB and undetermined subjects/permissions
    yield default deny with empty sources, never a fabricated deny source."""

    def test_empty_db(self):
        result = make_policy({}).check("u", "p")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["sources"], {"allow": [], "deny": []})
        self.assertEqual(result["epoch"], 0)

    def test_unknown_user(self):
        policy = make_policy({"roles": {"r": {"allow": ["p"]}}, "users": {"v": ["r"]}})
        result = policy.check("ghost", "p")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["sources"], {"allow": [], "deny": []})

    def test_unknown_permission(self):
        policy = make_policy({"roles": {"r": {"allow": ["p"]}}, "users": {"u": ["r"]}})
        result = policy.check("u", "other")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["sources"], {"allow": [], "deny": []})

    def test_unknown_assigned_role_ignored(self):
        policy = make_policy({"roles": {"r": {"allow": ["p"]}}, "users": {"u": ["r", "ghost"]}})
        self.assertEqual(policy.check("u", "p")["decision"], "allow")


class TestMultiSourceAndCascade(unittest.TestCase):
    """Rule 4: all sources recorded; removal only when the source set is empty.
    Rule 2: role revocation cascades only to permissions obtained solely via it."""

    def test_multiple_sources_all_recorded(self):
        policy = make_policy(
            {
                "roles": {
                    "a": {"allow": ["p"]},
                    "b": {"inherits": ["c"]},
                    "c": {"allow": ["p"]},
                },
                "users": {"u": ["a", "b"]},
            }
        )
        self.assertEqual(policy.check("u", "p")["sources"]["allow"], ["a", "c"])

    def test_role_revocation_cascades_only_exclusive_permissions(self):
        policy = make_policy(
            {
                "roles": {
                    "keep": {"allow": ["shared"]},
                    "gone": {"inherits": ["deep"], "allow": ["shared", "exclusive"]},
                    "deep": {"allow": ["deep-only"]},
                },
                "users": {"u": ["keep", "gone"]},
                "revocations": [{"epoch": 3, "type": "role", "role": "gone"}],
            }
        )
        self.assertEqual(policy.check("u", "shared")["decision"], "allow")
        self.assertEqual(policy.check("u", "shared")["sources"]["allow"], ["keep"])
        self.assertEqual(policy.check("u", "exclusive")["decision"], "deny")
        self.assertEqual(policy.check("u", "deep-only")["decision"], "deny")

    def test_partial_source_removal_keeps_permission(self):
        policy = make_policy(
            {
                "roles": {"a": {"allow": ["p"]}, "b": {"allow": ["p"]}},
                "users": {"u": ["a", "b"]},
                "revocations": [{"epoch": 1, "type": "allow", "role": "a", "perm": "p"}],
            }
        )
        result = policy.check("u", "p")
        self.assertEqual(result["decision"], "allow")
        self.assertEqual(result["sources"]["allow"], ["b"])


class TestEpochs(unittest.TestCase):
    """Rule 2: revocations apply monotonically by epoch regardless of file order."""

    def test_out_of_order_events_apply_by_epoch(self):
        policy = make_policy(
            {
                "roles": {"r": {"allow": ["p", "q"]}},
                "users": {"u": ["r"]},
                "revocations": [
                    {"epoch": 2, "type": "allow", "role": "r", "perm": "q"},
                    {"epoch": 1, "type": "allow", "role": "r", "perm": "p"},
                ],
            }
        )
        self.assertEqual(policy.check("u", "p")["decision"], "deny")
        self.assertEqual(policy.check("u", "q")["decision"], "deny")
        self.assertEqual(policy.epoch, 2)

    def test_assign_revocation(self):
        policy = make_policy(
            {
                "roles": {"r": {"allow": ["p"]}},
                "users": {"u": ["r"]},
                "revocations": [{"epoch": 7, "type": "assign", "user": "u", "role": "r"}],
            }
        )
        result = policy.check("u", "p")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["epoch"], 7)

    def test_revocation_of_missing_target_is_noop(self):
        policy = make_policy(
            {
                "roles": {"r": {"allow": ["p"]}},
                "users": {"u": ["r"]},
                "revocations": [
                    {"epoch": 1, "type": "role", "role": "ghost"},
                    {"epoch": 2, "type": "edge", "role": "r", "target": "ghost"},
                    {"epoch": 3, "type": "allow", "role": "ghost", "perm": "p"},
                ],
            }
        )
        self.assertEqual(policy.check("u", "p")["decision"], "allow")
        self.assertEqual(policy.epoch, 3)


class TestErrors(unittest.TestCase):
    def assert_code(self, code, fn, *args):
        with self.assertRaises(PolicyError) as ctx:
            fn(*args)
        self.assertEqual(ctx.exception.code, code)

    def test_invalid_json(self):
        self.assert_code("invalid_json", load_policy, "{not json")

    def test_top_level_not_object(self):
        self.assert_code("invalid_schema", load_policy, "[1, 2]")

    def test_unknown_top_level_key(self):
        self.assert_code("invalid_schema", make_policy, {"rolez": {}})

    def test_role_spec_not_object(self):
        self.assert_code("invalid_schema", make_policy, {"roles": {"r": 1}})

    def test_inherits_unknown_role(self):
        self.assert_code(
            "unknown_role", make_policy, {"roles": {"r": {"inherits": ["ghost"]}}}
        )

    def test_bad_epoch_negative(self):
        self.assert_code(
            "invalid_epoch",
            make_policy,
            {"revocations": [{"epoch": -1, "type": "role", "role": "r"}]},
        )

    def test_bad_epoch_type(self):
        self.assert_code(
            "invalid_epoch",
            make_policy,
            {"revocations": [{"epoch": "1", "type": "role", "role": "r"}]},
        )

    def test_unknown_revocation_type(self):
        self.assert_code(
            "invalid_schema",
            make_policy,
            {"revocations": [{"epoch": 1, "type": "explode"}]},
        )

    def test_error_str_contains_code(self):
        try:
            load_policy("nope")
        except PolicyError as exc:
            self.assertIn("invalid_json", str(exc))
        else:
            self.fail("expected PolicyError")


if __name__ == "__main__":
    unittest.main()
