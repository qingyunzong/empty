"""Shared network builders for the test suite."""

from mcfcert import Edge, Network


def diamond():
    """Two parallel s-t paths: cheap path via a (cost 1/arc), via b (cost 3/arc)."""
    return Network(
        nodes=["s", "a", "b", "t"],
        edges=[
            Edge("e_sa", "s", "a", 0, 4, 1),
            Edge("e_at", "a", "t", 0, 4, 1),
            Edge("e_sb", "s", "b", 0, 4, 3),
            Edge("e_bt", "b", "t", 0, 4, 3),
        ],
        demands={"s": -4, "t": 4},
    )


def path_network():
    """Single s->a->b->t path, capacity 5 per arc."""
    return Network(
        nodes=["s", "a", "b", "t"],
        edges=[
            Edge("e_sa", "s", "a", 0, 5, 1),
            Edge("e_ab", "a", "b", 0, 5, 1),
            Edge("e_bt", "b", "t", 0, 5, 1),
        ],
        demands={"s": -5, "t": 5},
    )


def bottleneck_direct():
    """Direct arc with small capacity plus a two-arc detour."""
    return Network(
        nodes=["s", "a", "t"],
        edges=[
            Edge("e_st", "s", "t", 0, 2, 1),
            Edge("e_sa", "s", "a", 0, 4, 1),
            Edge("e_at", "a", "t", 0, 4, 1),
        ],
        demands={"s": -4, "t": 4},
    )


def tie_network():
    """Two paths whose minimal repairs tie on modifications and L1 but not cost."""
    return Network(
        nodes=["s", "a", "b", "t"],
        edges=[
            Edge("e_sa", "s", "a", 0, 2, 1),
            Edge("e_at", "a", "t", 0, 2, 1),
            Edge("e_sb", "s", "b", 0, 2, 5),
            Edge("e_bt", "b", "t", 0, 2, 5),
        ],
        demands={"s": -2, "t": 2},
    )


def infeasible_network():
    """Demand 5 across a capacity-3 cut: no feasible flow exists."""
    return Network(
        nodes=["s", "t"],
        edges=[Edge("e_st", "s", "t", 0, 3, 1)],
        demands={"s": -5, "t": 5},
    )


def lower_bound_network():
    """Single edge with a nonzero lower bound."""
    return Network(
        nodes=["s", "t"],
        edges=[Edge("e_st", "s", "t", 2, 5, 1)],
        demands={"s": -4, "t": 4},
    )


def imbalanced_network():
    """Demands that do not sum to zero."""
    return Network(
        nodes=["s", "t"],
        edges=[Edge("e_st", "s", "t", 0, 10, 1)],
        demands={"s": -3, "t": 4},
    )
