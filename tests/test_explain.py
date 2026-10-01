"""Tests for the 1-UIP explanation generator.

Includes a naive reference implementation that enumerates every cut set
of the implication graph, keeps the minimal cuts containing exactly one
current-level node (1-UIP cuts) and selects the first UIP (the one
closest to the conflict).  The library output must match it exactly.
"""

from __future__ import annotations

import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from csp_explain import ExplainError, analyze, analyze_literals, load_model

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CONFLICT = "__conflict__"


# ---------------------------------------------------------------------------
# Naive reference: enumerate all cut sets of the implication graph.
# ---------------------------------------------------------------------------

def _backward_closure(model):
    nodes = set()
    stack = list(model.conflict_antecedents)
    while stack:
        lit = stack.pop()
        if lit in nodes:
            continue
        nodes.add(lit)
        stack.extend(model.antecedents_of(lit))
    return nodes


def _is_cut(model, nodes, cut):
    """True if removing `cut` disconnects every root from the conflict."""
    cut = set(cut)
    children = {node: [] for node in nodes}
    for node in nodes:
        for ant in model.antecedents_of(node):
            children[ant].append(node)
    for lit in model.conflict_antecedents:
        children[lit].append(CONFLICT)

    roots = [n for n in nodes if not model.antecedents_of(n) and n not in cut]
    reached = set()
    stack = list(roots)
    while stack:
        node = stack.pop()
        if node in reached or node in cut:
            continue
        reached.add(node)
        stack.extend(children.get(node, ()))
    return CONFLICT not in reached


def naive_first_uip(model):
    """Reference result via brute-force enumeration of all cut sets.

    Returns (frozenset of clause literals, backjump level).
    """
    current_level = max(
        (model.level_of(l) for l in model.conflict_antecedents), default=0
    )
    if current_level == 0:
        return frozenset(), -1

    nodes = sorted(_backward_closure(model))
    valid_cuts = []
    for size in range(len(nodes) + 1):
        for combo in itertools.combinations(nodes, size):
            at_current = [l for l in combo if model.level_of(l) == current_level]
            if len(at_current) != 1:
                continue
            if not _is_cut(model, nodes, combo):
                continue
            # keep only necessary premises: no proper subset may be a cut
            minimal = True
            for smaller in range(size):
                if any(
                    _is_cut(model, nodes, sub)
                    for sub in itertools.combinations(combo, smaller)
                ):
                    minimal = False
                    break
            if minimal:
                valid_cuts.append(combo)

    assert valid_cuts, "expected at least one 1-UIP cut"
    uips = {next(l for l in cut if model.level_of(l) == current_level) for cut in valid_cuts}

    def reachable_from(start):
        seen = set()
        stack = [start]
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            for other in nodes:
                if node in model.antecedents_of(other):
                    stack.append(other)
        return seen

    # first UIP = the dominator closest to the conflict, i.e. reachable
    # from every other UIP candidate along implication edges
    first_uips = [u for u in uips if all(u in reachable_from(other) for other in uips)]
    assert len(first_uips) == 1, f"UIP candidates not totally ordered: {uips}"
    first_uip = first_uips[0]

    candidates = [
        cut
        for cut in valid_cuts
        if next(l for l in cut if model.level_of(l) == current_level) == first_uip
    ]
    # Several minimal cuts may share the first UIP; the 1-UIP clause is the
    # one closest to the conflict: every node of any other candidate cut is
    # either in it or an ancestor of one of its nodes.
    closest = [
        cut
        for cut in candidates
        if all(
            all(any(node in reachable_from(other_node) for other_node in other)
                for node in cut)
            for other in candidates
        )
    ]
    assert len(closest) == 1, f"expected a unique closest cut: {candidates}"
    clause = frozenset(closest[0])
    lower = [model.level_of(l) for l in clause if model.level_of(l) < current_level]
    backjump = max(lower) if lower else 0
    return clause, backjump


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def chain_three_variables():
    """Fixed propagation chain over three variables x, y, z."""
    return {
        "variables": ["x", "y", "z"],
        "decisions": [{"variable": "x", "value": 1, "level": 1}],
        "implications": [
            {"id": "p1", "variable": "y", "removed_value": 2, "level": 1,
             "constraint": "c_xy", "antecedents": ["decision:x"]},
            {"id": "p2", "variable": "z", "removed_value": 3, "level": 1,
             "constraint": "c_yz", "antecedents": ["p1"]},
            {"id": "p3", "variable": "y", "removed_value": 3, "level": 1,
             "constraint": "c_yy", "antecedents": ["p2"]},
        ],
        "conflict": {"constraint": "c_fail", "antecedents": ["p3", "p1"]},
    }


def multilevel_conflict():
    """Three decision levels; the 1-UIP clause skips level 2."""
    return {
        "variables": ["a", "b", "c", "d"],
        "decisions": [
            {"variable": "a", "value": 1, "level": 1},
            {"variable": "b", "value": 2, "level": 2},
            {"variable": "c", "value": 3, "level": 3},
        ],
        "implications": [
            {"id": "q1", "variable": "d", "removed_value": 1, "level": 1,
             "constraint": "k1", "antecedents": ["decision:a"]},
            {"id": "q2", "variable": "d", "removed_value": 2, "level": 2,
             "constraint": "k2", "antecedents": ["decision:b", "q1"]},
            {"id": "q3", "variable": "b", "removed_value": 5, "level": 3,
             "constraint": "k3", "antecedents": ["decision:c", "q2"]},
            {"id": "q4", "variable": "c", "removed_value": 4, "level": 3,
             "constraint": "k4", "antecedents": ["q3", "q1"]},
        ],
        "conflict": {"constraint": "k5", "antecedents": ["q4", "q3"]},
    }


def level_zero_conflict():
    return {
        "variables": ["x", "y"],
        "decisions": [],
        "implications": [
            {"id": "z1", "variable": "x", "removed_value": 1, "level": 0,
             "constraint": "u1", "antecedents": []},
            {"id": "z2", "variable": "y", "removed_value": 2, "level": 0,
             "constraint": "u2", "antecedents": ["z1"]},
        ],
        "conflict": {"constraint": "u3", "antecedents": ["z2", "z1"]},
    }


def random_instance(rng):
    """Build a random but internally consistent search record."""
    n_vars = rng.randint(2, 4)
    variables = [f"v{i}" for i in range(n_vars)]
    n_levels = rng.randint(1, min(3, n_vars))
    decisions = [
        {"variable": variables[lvl - 1], "value": lvl, "level": lvl}
        for lvl in range(1, n_levels + 1)
    ]

    # available antecedent refs grouped by level
    by_level = {lvl: [] for lvl in range(0, n_levels + 1)}
    for dec in decisions:
        by_level[dec["level"]].append(f"decision:{dec['variable']}")

    implications = []
    for idx in range(rng.randint(2, 6)):
        level = rng.randint(0, n_levels)
        candidates = [r for lvl in range(0, level + 1) for r in by_level[lvl]]
        top = list(by_level[level])
        ants = []
        for ref in candidates:
            if rng.random() < 0.35:
                ants.append(ref)
        if level > 0 and not any(r in ants for r in top):
            if not top:
                continue
            ants.append(rng.choice(top))
        ants = sorted(set(ants))
        ident = f"i{idx}"
        implications.append({
            "id": ident,
            "variable": rng.choice(variables),
            "removed_value": rng.randint(0, 5),
            "level": level,
            "constraint": f"c{idx}",
            "antecedents": ants,
        })
        by_level[level].append(ident)

    all_refs = [r for lvl in by_level.values() for r in lvl]
    n_conf = rng.randint(0, min(3, len(all_refs)))
    conflict_ants = sorted(set(rng.sample(all_refs, n_conf))) if n_conf else []
    return {
        "variables": variables,
        "decisions": decisions,
        "implications": implications,
        "conflict": {"constraint": "cf", "antecedents": conflict_ants},
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class AcceptanceScenarios(unittest.TestCase):
    def test_chain_three_variables_matches_naive_cut_enumeration(self):
        model = load_model(chain_three_variables())
        clause, backjump = analyze_literals(model)
        expected_clause, expected_backjump = naive_first_uip(model)
        self.assertEqual(frozenset(clause), expected_clause)
        self.assertEqual(backjump, expected_backjump)
        # the chain resolves to the single first-UIP literal y != 2
        self.assertEqual(clause, [("implication", "p1")])
        self.assertEqual(backjump, 0)

    def test_level_zero_conflict_is_unsat(self):
        model = load_model(level_zero_conflict())
        result = analyze(model)
        self.assertEqual(result["clause"], [])
        self.assertEqual(result["backjump_level"], -1)
        self.assertEqual(result["status"], "unsat")

    def test_broken_implication_records_raise(self):
        base = chain_three_variables()

        unknown_implication = json.loads(json.dumps(base))
        unknown_implication["implications"][1]["antecedents"] = ["nope"]
        with self.assertRaises(ExplainError):
            load_model(unknown_implication)

        unknown_decision = json.loads(json.dumps(base))
        unknown_decision["implications"][0]["antecedents"] = ["decision:ghost"]
        with self.assertRaises(ExplainError):
            load_model(unknown_decision)

        unknown_variable = json.loads(json.dumps(base))
        unknown_variable["implications"][0]["variable"] = "ghost"
        with self.assertRaises(ExplainError):
            load_model(unknown_variable)

        unknown_decision_variable = json.loads(json.dumps(base))
        unknown_decision_variable["decisions"][0]["variable"] = "ghost"
        with self.assertRaises(ExplainError):
            load_model(unknown_decision_variable)

        forward_reference = json.loads(json.dumps(base))
        forward_reference["implications"][0]["antecedents"] = ["p2"]
        with self.assertRaises(ExplainError):
            load_model(forward_reference)

    def test_missing_conflict_state_raises(self):
        broken = chain_three_variables()
        del broken["conflict"]
        with self.assertRaises(ExplainError):
            load_model(broken)
        broken = chain_three_variables()
        broken["conflict"] = None
        with self.assertRaises(ExplainError):
            load_model(broken)

    def test_multilevel_conflict_backjump_level(self):
        model = load_model(multilevel_conflict())
        clause, backjump = analyze_literals(model)
        expected_clause, expected_backjump = naive_first_uip(model)
        self.assertEqual(frozenset(clause), expected_clause)
        self.assertEqual(backjump, expected_backjump)
        # clause = {b != 5 @L3 (the UIP), d != 1 @L1}; level 2 is skipped
        self.assertEqual(frozenset(clause), frozenset({("implication", "q3"), ("implication", "q1")}))
        self.assertEqual(backjump, 1)


class NaiveReferenceCrossCheck(unittest.TestCase):
    def test_random_instances_match_naive_cut_enumeration(self):
        checked = 0
        for seed in (20261001, 7, 424242):
            rng = random.Random(seed)
            for _ in range(80):
                instance = random_instance(rng)
                model = load_model(instance)
                clause, backjump = analyze_literals(model)
                expected_clause, expected_backjump = naive_first_uip(model)
                self.assertEqual(
                    frozenset(clause),
                    expected_clause,
                    msg=f"clause mismatch for instance {json.dumps(instance)}",
                )
                self.assertEqual(
                    backjump,
                    expected_backjump,
                    msg=f"backjump mismatch for instance {json.dumps(instance)}",
                )
                checked += 1
        self.assertEqual(checked, 240)


class CliTests(unittest.TestCase):
    def _run_cli(self, payload):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as handle:
            json.dump(payload, handle)
            path = handle.name
        try:
            return subprocess.run(
                [sys.executable, "-m", "csp_explain", "generate", "--input", path],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
            )
        finally:
            os.unlink(path)

    def test_cli_generate_outputs_clause_and_backjump_level(self):
        proc = self._run_cli(multilevel_conflict())
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["backjump_level"], 1)
        self.assertEqual(result["status"], "backjump")
        kinds = {(lit["kind"], lit["variable"], lit["value"]) for lit in result["clause"]}
        self.assertEqual(kinds, {("removal", "b", 5), ("removal", "d", 1)})

    def test_cli_level_zero_conflict(self):
        proc = self._run_cli(level_zero_conflict())
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["clause"], [])
        self.assertEqual(result["backjump_level"], -1)
        self.assertEqual(result["status"], "unsat")

    def test_cli_broken_record_returns_nonzero(self):
        broken = chain_three_variables()
        broken["conflict"]["antecedents"] = ["missing"]
        proc = self._run_cli(broken)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("missing", proc.stderr)

    def test_cli_missing_conflict_returns_nonzero(self):
        broken = chain_three_variables()
        del broken["conflict"]
        proc = self._run_cli(broken)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("conflict", proc.stderr)


if __name__ == "__main__":
    unittest.main()
