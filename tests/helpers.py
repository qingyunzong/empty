"""Shared network builders for the test-suite."""

from mcflow import Edge, Network


def diamond_network():
    """s -> a -> t plus a direct expensive s -> t edge."""
    return Network(
        nodes=["s", "a", "t"],
        edges=[
            Edge("e1", "s", "a", 0, 4, 1),
            Edge("e2", "a", "t", 0, 4, 1),
            Edge("e3", "s", "t", 0, 4, 5),
        ],
        demands={"s": -3, "a": 0, "t": 3},
    )


def negative_cycle_network():
    """Zero-demand circulation network with a negative-cost cycle."""
    return Network(
        nodes=["x", "y"],
        edges=[
            Edge("e1", "x", "y", 0, 3, -2),
            Edge("e2", "y", "x", 0, 3, -1),
        ],
        demands={"x": 0, "y": 0},
    )


def cascade_network():
    """Path s->a->b->t plus a direct escape edge e4.

    In the base flow only e1 exceeds its capacity, but pushing e1 back
    inside its bounds forces a chain of further modifications.
    """
    return Network(
        nodes=["s", "a", "b", "t"],
        edges=[
            Edge("e1", "s", "a", 0, 2, 1),
            Edge("e2", "a", "b", 0, 5, 1),
            Edge("e3", "b", "t", 0, 5, 1),
            Edge("e4", "s", "t", 0, 1, 10),
        ],
        demands={"s": -3, "a": 0, "b": 0, "t": 3},
    )


def l1_tiebreak_network():
    """Two parallel s->x edges; repairing via e1 has smaller L1 than via e4."""
    return Network(
        nodes=["s", "x", "t"],
        edges=[
            Edge("e1", "s", "x", 0, 5, 1),
            Edge("e2", "x", "t", 0, 5, 1),
            Edge("e4", "s", "x", 0, 5, 1),
        ],
        demands={"s": -3, "x": 0, "t": 3},
    )


def infeasible_network():
    """Lower bound 5 on the only edge exceeds the demand of 3."""
    return Network(
        nodes=["s", "t"],
        edges=[Edge("e1", "s", "t", 5, 10, 1)],
        demands={"s": -3, "t": 3},
    )
