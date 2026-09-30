"""Unit tests for jsonmerge3.merge3.

Includes an independent recursive path-enumeration checker: for small
trees of depth <= 3 it builds the expected merge result path by path
with a naive reference implementation written separately from the
package, then verifies every path of the real merge output.
"""

import unittest

from jsonmerge3 import merge3


# ---------------------------------------------------------------------------
# Independent reference implementation (naive spec, shares no code with the
# package under test).
# ---------------------------------------------------------------------------

ABSENT = object()


def _norm(value):
    return None if value is ABSENT else value


def _eq(a, b):
    a = _norm(a)
    b = _norm(b)
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(_eq(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b


def ref_node(base, ours, theirs):
    """Naive three-way merge of one node.

    Returns (value_or_ABSENT, set_of_relative_conflict_paths).
    """
    if _eq(ours, theirs):
        return ours, set()
    if _eq(base, ours):
        return theirs, set()
    if _eq(base, theirs):
        return ours, set()
    if isinstance(ours, dict) and isinstance(theirs, dict):
        base_dict = base if isinstance(base, dict) else {}
        value = {}
        conflicts = set()
        keys = list(dict.fromkeys(
            list(base_dict) + list(ours) + list(theirs)
        ))
        for key in keys:
            sub, sub_conflicts = ref_node(
                base_dict.get(key, ABSENT),
                ours.get(key, ABSENT),
                theirs.get(key, ABSENT),
            )
            if sub is not ABSENT:
                value[key] = sub
            conflicts |= {(key,) + p for p in sub_conflicts}
        return value, conflicts
    if isinstance(ours, list) and isinstance(theirs, list):
        base_list = base if isinstance(base, list) else []
        size = max(len(base_list), len(ours), len(theirs))
        value = []
        conflicts = set()
        for index in range(size):
            sub, sub_conflicts = ref_node(
                base_list[index] if index < len(base_list) else ABSENT,
                ours[index] if index < len(ours) else ABSENT,
                theirs[index] if index < len(theirs) else ABSENT,
            )
            value.append(None if sub is ABSENT else sub)
            conflicts |= {(index,) + p for p in sub_conflicts}
        return value, conflicts
    return ours, {()}


def ref_merge(base, ours, theirs):
    value, conflicts = ref_node(base, ours, theirs)
    if value is ABSENT:
        value = None
    return value, conflicts


# ---------------------------------------------------------------------------
# Independent recursive enumeration helpers.
# ---------------------------------------------------------------------------

def enumerate_paths(node, path=()):
    """Yield every (path, value) pair of a JSON tree, recursively."""
    yield path, node
    if isinstance(node, dict):
        for key, sub in node.items():
            yield from enumerate_paths(sub, path + (key,))
    elif isinstance(node, list):
        for index, sub in enumerate(node):
            yield from enumerate_paths(sub, path + (index,))


def get_path(tree, path):
    node = tree
    for token in path:
        node = node[token]
    return node


def tree_depth(node):
    if isinstance(node, dict) and node:
        return 1 + max(tree_depth(v) for v in node.values())
    if isinstance(node, list) and node:
        return 1 + max(tree_depth(v) for v in node)
    if isinstance(node, (dict, list)):
        return 1
    return 0


def pointer_of(path):
    return "".join(
        "/" + str(t).replace("~", "~0").replace("/", "~1") for t in path
    )


# ---------------------------------------------------------------------------
# Small test trees (depth <= 3).
# ---------------------------------------------------------------------------

CASES = {
    "nested_non_conflicting_edits": (
        {"a": {"b": 1, "c": 2}, "d": {"e": {"f": 3}}},
        {"a": {"b": 10, "c": 2}, "d": {"e": {"f": 3}}},
        {"a": {"b": 1, "c": 2}, "d": {"e": {"f": 30}}},
    ),
    "delete_vs_modify_conflict": (
        {"keep": 1, "gone": {"x": 5}},
        {"keep": 1},
        {"keep": 1, "gone": {"x": 6}},
    ),
    "array_append_vs_modify_existing": (
        {"list": [1, 2]},
        {"list": [1, 2, 3]},
        {"list": [1, 20]},
    ),
    "array_same_new_index_different_values": (
        {"list": [1]},
        {"list": [1, 2]},
        {"list": [1, 3]},
    ),
    "added_key_same_value_both_sides": (
        {"a": 1},
        {"a": 1, "new": {"n": [1, 2]}},
        {"a": 1, "new": {"n": [1, 2]}},
    ),
    "added_key_different_values": (
        {"a": 1},
        {"a": 1, "new": "ours"},
        {"a": 1, "new": "theirs"},
    ),
    "delete_vs_delete": (
        {"a": 1, "b": {"c": [1, 2]}},
        {"a": 1},
        {"a": 1},
    ),
    "type_change_one_side": (
        {"a": {"b": {"c": 1}}},
        {"a": "scalar"},
        {"a": {"b": {"c": 1}}},
    ),
    "null_vs_missing": (
        {"a": 1},
        {"a": 1, "b": None},
        {"a": 1},
    ),
    "nested_array_of_objects": (
        [{"k": 1}, {"k": 2, "extra": [True]}],
        [{"k": 1}, {"k": 2, "extra": [True, False]}],
        [{"k": 9}, {"k": 2, "extra": [True]}],
    ),
    "both_sides_same_deep_change": (
        {"a": {"b": [1, 2]}},
        {"a": {"b": [1, 2, 3]}},
        {"a": {"b": [1, 2, 3]}},
    ),
    "root_scalar_conflict": (1, 2, 3),
}


class ExplicitSemanticsTest(unittest.TestCase):
    def test_nested_non_conflicting_edits(self):
        base, ours, theirs = CASES["nested_non_conflicting_edits"]
        merged, conflicts = merge3(base, ours, theirs)
        self.assertEqual(conflicts, [])
        self.assertEqual(
            merged,
            {"a": {"b": 10, "c": 2}, "d": {"e": {"f": 30}}},
        )

    def test_delete_vs_modify_conflict(self):
        base, ours, theirs = CASES["delete_vs_modify_conflict"]
        merged, conflicts = merge3(base, ours, theirs)
        self.assertEqual(conflicts, ["/gone"])
        # Conflict resolves to "ours" (the deletion).
        self.assertEqual(merged, {"keep": 1})

    def test_array_append_vs_modify_existing(self):
        base, ours, theirs = CASES["array_append_vs_modify_existing"]
        merged, conflicts = merge3(base, ours, theirs)
        self.assertEqual(conflicts, [])
        self.assertEqual(merged, {"list": [1, 20, 3]})

    def test_array_same_new_index_different_values(self):
        base, ours, theirs = CASES["array_same_new_index_different_values"]
        merged, conflicts = merge3(base, ours, theirs)
        self.assertEqual(conflicts, ["/list/1"])
        self.assertEqual(merged, {"list": [1, 2]})

    def test_added_key_same_value_both_sides(self):
        base, ours, theirs = CASES["added_key_same_value_both_sides"]
        merged, conflicts = merge3(base, ours, theirs)
        self.assertEqual(conflicts, [])
        self.assertEqual(merged, {"a": 1, "new": {"n": [1, 2]}})

    def test_added_key_different_values_conflict(self):
        base, ours, theirs = CASES["added_key_different_values"]
        merged, conflicts = merge3(base, ours, theirs)
        self.assertEqual(conflicts, ["/new"])
        self.assertEqual(merged, {"a": 1, "new": "ours"})

    def test_root_scalar_conflict_pointer_is_empty_string(self):
        merged, conflicts = merge3(1, 2, 3)
        self.assertEqual(conflicts, [""])
        self.assertEqual(merged, 2)


class IndependentEnumerationTest(unittest.TestCase):
    """Verify small trees (depth <= 3) path by path against the naive
    reference, using an independent recursive enumeration function."""

    def test_all_cases_path_by_path(self):
        for name, (base, ours, theirs) in CASES.items():
            with self.subTest(case=name):
                for tree in (base, ours, theirs):
                    self.assertLessEqual(
                        tree_depth(tree), 3,
                        f"test tree {name!r} exceeds depth 3",
                    )

                expected, expected_conflicts = ref_merge(base, ours, theirs)
                merged, conflicts = merge3(base, ours, theirs)

                # Every path of the expected tree must match the real merge.
                for path, expected_value in enumerate_paths(expected):
                    actual_value = get_path(merged, path)
                    self.assertTrue(
                        _eq(expected_value, actual_value),
                        f"path {pointer_of(path)!r}: expected "
                        f"{expected_value!r}, got {actual_value!r}",
                    )

                # No extra paths may exist in the real merge result.
                self.assertEqual(
                    sorted(p for p, _ in enumerate_paths(expected)),
                    sorted(p for p, _ in enumerate_paths(merged)),
                )

                # Conflict report matches the independently computed set.
                self.assertEqual(
                    sorted(pointer_of(p) for p in expected_conflicts),
                    sorted(conflicts),
                )


if __name__ == "__main__":
    unittest.main()
