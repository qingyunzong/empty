"""Shared machine definitions for the test suite."""
from mealy.machine import MealyMachine


def simple_machine():
    """Three pairwise distinguishable states; preset sequence 'ba' works."""
    return MealyMachine(
        states=["s1", "s2", "s3"],
        inputs=["a", "b"],
        transitions={
            "s1": {"a": ["s1", "0"], "b": ["s2", "0"]},
            "s2": {"a": ["s1", "0"], "b": ["s2", "1"]},
            "s3": {"a": ["s3", "1"], "b": ["s3", "0"]},
        },
    )


def adaptive_only_machine():
    """Every pair of {A1,A2,B1,B2} is distinguishable, yet no preset
    sequence separates the whole set: after any two inputs some pair has
    merged into the sink M.  An adaptive tree of depth 2 exists.
    """
    return MealyMachine(
        states=["A1", "A2", "B1", "B2", "al1", "al2", "be1", "be2", "M"],
        inputs=["x", "a", "b"],
        transitions={
            "A1": {"x": ["al1", "0"], "a": ["M", "0"], "b": ["M", "0"]},
            "A2": {"x": ["al2", "0"], "a": ["M", "0"], "b": ["M", "0"]},
            "B1": {"x": ["be1", "1"], "a": ["M", "0"], "b": ["M", "0"]},
            "B2": {"x": ["be2", "1"], "a": ["M", "0"], "b": ["M", "0"]},
            "al1": {"a": ["al1", "0"], "b": ["M", "0"], "x": ["M", "0"]},
            "al2": {"a": ["al2", "1"], "b": ["M", "0"], "x": ["M", "0"]},
            "be1": {"b": ["be1", "0"], "a": ["M", "0"], "x": ["M", "0"]},
            "be2": {"b": ["be2", "1"], "a": ["M", "0"], "x": ["M", "0"]},
            "M": {"a": ["M", "0"], "b": ["M", "0"], "x": ["M", "0"]},
        },
    )


ADAPTIVE_SET = ["A1", "A2", "B1", "B2"]


def sharing_machine():
    """Inputs x and y lead to the same sub-configuration {A,B}@(P,Q), so the
    solver's memoisation must share that subproblem.  Optimal depth is 2
    (via y); x needs depth 4 because the pair (U1,V1) has distance 3.
    """
    return MealyMachine(
        states=["A", "B", "C", "D", "P", "Q", "U1", "V1", "W1", "W2"],
        inputs=["x", "y", "z"],
        transitions={
            "A": {"x": ["P", "0"], "y": ["P", "0"], "z": ["A", "1"]},
            "B": {"x": ["Q", "0"], "y": ["Q", "0"], "z": ["B", "0"]},
            "C": {"x": ["U1", "1"], "y": ["P", "1"], "z": ["C", "0"]},
            "D": {"x": ["V1", "1"], "y": ["Q", "1"], "z": ["D", "0"]},
            "P": {"x": ["P", "0"], "y": ["P", "0"], "z": ["P", "0"]},
            "Q": {"x": ["Q", "0"], "y": ["Q", "0"], "z": ["Q", "1"]},
            "U1": {"x": ["W1", "0"], "y": ["W1", "0"], "z": ["W1", "0"]},
            "V1": {"x": ["W2", "0"], "y": ["W2", "0"], "z": ["W2", "0"]},
            "W1": {"x": ["P", "0"], "y": ["P", "0"], "z": ["P", "0"]},
            "W2": {"x": ["Q", "0"], "y": ["Q", "0"], "z": ["Q", "0"]},
        },
    )


SHARING_SET = ["A", "B", "C", "D"]


def partial_machine():
    """Partial transition function: S1 has no transition for input b."""
    return MealyMachine(
        states=["S1", "S2"],
        inputs=["a", "b"],
        transitions={
            "S1": {"a": ["S1", "0"]},
            "S2": {"a": ["S2", "0"], "b": ["S2", "1"]},
        },
    )


def equivalent_machine():
    """E1 and E2 are equivalent (isomorphic rows); E3 is distinguishable."""
    return MealyMachine(
        states=["E1", "E2", "E3"],
        inputs=["x", "y"],
        transitions={
            "E1": {"x": ["E1", "0"], "y": ["E3", "0"]},
            "E2": {"x": ["E2", "0"], "y": ["E3", "0"]},
            "E3": {"x": ["E3", "1"], "y": ["E3", "0"]},
        },
    )


def same_name_output_machine():
    """Output names are reused across many transitions; grouping must be by
    output equality."""
    return MealyMachine(
        states=["N1", "N2", "N3"],
        inputs=["i", "j"],
        transitions={
            "N1": {"i": ["N1", "ping"], "j": ["N1", "ping"]},
            "N2": {"i": ["N2", "ping"], "j": ["N2", "pong"]},
            "N3": {"i": ["N3", "pong"], "j": ["N3", "ping"]},
        },
    )


def resume_machine():
    """Every pair is separated in one step (lower bound 1) but the optimal
    tree needs depth 2, so iterative deepening performs several rounds."""
    return MealyMachine(
        states=["r1", "r2", "r3"],
        inputs=["a", "b"],
        transitions={
            "r1": {"a": ["r1", "0"], "b": ["r1", "0"]},
            "r2": {"a": ["r2", "1"], "b": ["r2", "0"]},
            "r3": {"a": ["r3", "1"], "b": ["r3", "2"]},
        },
    )


def cycle_machine():
    """Input x swaps the two candidates (a no-progress cycle); y separates
    them immediately.  The solver must cut the cycle and stay sound."""
    return MealyMachine(
        states=["c1", "c2"],
        inputs=["x", "y"],
        transitions={
            "c1": {"x": ["c2", "0"], "y": ["c1", "0"]},
            "c2": {"x": ["c1", "0"], "y": ["c2", "1"]},
        },
    )
