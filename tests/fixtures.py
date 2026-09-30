"""Shared machine fixtures for the test suite."""

from mealy_dist.machine import MealyMachine


def three_state_machine() -> MealyMachine:
    """Reduced machine; preset and adaptive optima coincide (2)."""
    return MealyMachine(
        states=("q0", "q1", "q2"),
        inputs=("a", "b"),
        outputs=("0", "1"),
        transitions={
            "q0": {"a": ("q1", "0"), "b": ("q0", "0")},
            "q1": {"a": ("q1", "0"), "b": ("q1", "1")},
            "q2": {"a": ("q2", "1"), "b": ("q2", "0")},
        },
    )


def gap_machine() -> MealyMachine:
    """Complete machine where the best preset sequence (3) is strictly
    longer than the best adaptive tree (2)."""
    return MealyMachine(
        states=("s0", "s1", "s2", "s3"),
        inputs=("a", "b"),
        outputs=("0", "1"),
        transitions={
            "s0": {"a": ("s2", "1"), "b": ("s1", "0")},
            "s1": {"a": ("s1", "1"), "b": ("s3", "1")},
            "s2": {"a": ("s0", "0"), "b": ("s1", "1")},
            "s3": {"a": ("s1", "0"), "b": ("s0", "1")},
        },
    )


def no_preset_machine() -> MealyMachine:
    """Complete, reduced machine with an adaptive tree (depth 4) but no
    preset distinguishing sequence of any length up to 12."""
    return MealyMachine(
        states=("s0", "s1", "s2", "s3"),
        inputs=("a", "b"),
        outputs=("0", "1"),
        transitions={
            "s0": {"a": ("s2", "1"), "b": ("s3", "0")},
            "s1": {"a": ("s2", "1"), "b": ("s0", "1")},
            "s2": {"a": ("s2", "1"), "b": ("s1", "0")},
            "s3": {"a": ("s1", "1"), "b": ("s2", "1")},
        },
    )


def partial_no_experiment_machine() -> MealyMachine:
    """Partial machine: every pair is distinguishable, yet no adaptive
    experiment (and hence no preset one) can separate all states at once,
    because every first input merges some pair of candidates."""
    return MealyMachine(
        states=("s0", "s1", "s2", "s3"),
        inputs=("a", "b"),
        outputs=("0", "1"),
        transitions={
            "s0": {"a": ("s0", "0"), "b": ("s2", "0")},
            "s1": {"a": ("s0", "1")},
            "s2": {"a": ("s0", "0")},
            "s3": {"a": ("s1", "1"), "b": ("s3", "1")},
        },
    )


def equivalent_machine() -> MealyMachine:
    """Machine with two equivalent (indistinguishable) states e0, e1."""
    return MealyMachine(
        states=("e0", "e1", "e2"),
        inputs=("a", "b"),
        outputs=("0", "1"),
        transitions={
            "e0": {"a": ("e2", "0"), "b": ("e0", "1")},
            "e1": {"a": ("e2", "0"), "b": ("e1", "1")},
            "e2": {"a": ("e2", "1"), "b": ("e2", "0")},
        },
    )


def shared_subproblem_machine() -> MealyMachine:
    """The root input x yields the same candidate set {s0, s1} on two
    different outputs, so the solver solves that subproblem once and
    reuses it through the memo table."""
    return MealyMachine(
        states=("a", "b", "c", "d", "s0", "s1"),
        inputs=("x", "y"),
        outputs=("0", "1"),
        transitions={
            "a": {"x": ("s0", "0"), "y": ("a", "1")},
            "b": {"x": ("s1", "0"), "y": ("b", "0")},
            "c": {"x": ("s0", "1"), "y": ("c", "0")},
            "d": {"x": ("s1", "1"), "y": ("d", "0")},
            "s0": {"x": ("s0", "0"), "y": ("s0", "0")},
            "s1": {"x": ("s1", "0"), "y": ("s1", "1")},
        },
    )


def same_output_machine() -> MealyMachine:
    """u and v emit identically named outputs on every input; they can
    only be told apart at depth 2 via the successor of v."""
    return MealyMachine(
        states=("u", "v", "w"),
        inputs=("a", "b"),
        outputs=("same", "diff"),
        transitions={
            "u": {"a": ("v", "same"), "b": ("u", "same")},
            "v": {"a": ("w", "same"), "b": ("v", "same")},
            "w": {"a": ("w", "same"), "b": ("w", "diff")},
        },
    )


def budget_machine() -> MealyMachine:
    """Full search needs 10 expanded nodes; with budget 4 the run stops
    after a complete (but not yet proven optimal) tree of height 4."""
    return MealyMachine(
        states=("s0", "s1", "s2", "s3", "s4"),
        inputs=("a", "b", "c"),
        outputs=("0", "1"),
        transitions={
            "s0": {"a": ("s2", "1"), "b": ("s1", "0"), "c": ("s3", "1")},
            "s1": {"a": ("s3", "0"), "b": ("s3", "0"), "c": ("s3", "0")},
            "s2": {"a": ("s1", "0"), "b": ("s2", "0"), "c": ("s1", "0")},
            "s3": {"a": ("s0", "0"), "b": ("s2", "1"), "c": ("s3", "0")},
            "s4": {"a": ("s4", "0"), "b": ("s4", "0"), "c": ("s0", "0")},
        },
    )
