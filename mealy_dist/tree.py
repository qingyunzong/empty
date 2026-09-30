"""Adaptive distinguishing trees and their certificates.

A tree node is either a leaf (the candidate set has been reduced to a
single state) or an internal node that applies one input and branches on
the observed output.  The tree maps every state of the machine to a
distinct root-to-leaf trace, so following the tree on the black box
identifies its state.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from .machine import MealyMachine


class TreeNode:
    __slots__ = ("kind", "states", "state", "symbol", "children")

    def __init__(
        self,
        kind: str,
        states: Tuple[str, ...],
        state: Optional[str] = None,
        symbol: Optional[str] = None,
        children: Optional[Dict[str, "TreeNode"]] = None,
    ) -> None:
        self.kind = kind  # "leaf" or "node"
        self.states = states
        self.state = state
        self.symbol = symbol
        self.children = children or {}

    @classmethod
    def leaf(cls, state: str) -> "TreeNode":
        return cls("leaf", (state,), state=state)

    @classmethod
    def node(cls, states: Tuple[str, ...], symbol: str, children: Dict[str, "TreeNode"]) -> "TreeNode":
        return cls("node", states, symbol=symbol, children=children)

    # -- structure ---------------------------------------------------------
    def height(self) -> int:
        if self.kind == "leaf":
            return 0
        return 1 + max(child.height() for child in self.children.values())

    def node_count(self) -> int:
        if self.kind == "leaf":
            return 1
        return 1 + sum(child.node_count() for child in self.children.values())

    def leaves(self) -> List["TreeNode"]:
        if self.kind == "leaf":
            return [self]
        out: List[TreeNode] = []
        for child in self.children.values():
            out.extend(child.leaves())
        return out

    def trace(self, machine: MealyMachine, state: str) -> Tuple[List[str], List[str], str]:
        """Replay from ``state``; returns (inputs, outputs, leaf_state)."""
        inputs: List[str] = []
        outputs: List[str] = []
        node = self
        current = state
        while node.kind != "leaf":
            symbol = node.symbol
            current, out = machine.step(current, symbol)
            inputs.append(symbol)
            outputs.append(out)
            node = node.children[out]
        return inputs, outputs, node.state

    # -- io ----------------------------------------------------------------
    def to_dict(self) -> dict:
        if self.kind == "leaf":
            return {"type": "leaf", "state": self.state}
        return {
            "type": "node",
            "input": self.symbol,
            "states": list(self.states),
            "children": {out: child.to_dict() for out, child in sorted(self.children.items())},
        }

    @classmethod
    def from_dict(cls, data: dict) -> "TreeNode":
        if data["type"] == "leaf":
            return cls.leaf(data["state"])
        children = {out: cls.from_dict(sub) for out, sub in data["children"].items()}
        return cls.node(tuple(data["states"]), data["input"], children)


def verify_tree(
    machine: MealyMachine,
    tree: TreeNode,
    states: Optional[Sequence[str]] = None,
) -> Tuple[bool, List[str]]:
    """Structural check under current-state uncertainty semantics.

    ``states`` is the uncertainty set at ``tree``; applying the node
    input must not merge two candidates into the same successor on the
    same output, and every leaf must be reached with a singleton set.
    """
    target = tuple(states) if states is not None else machine.states
    errors: List[str] = []
    if tree.kind == "leaf":
        if len(target) != 1:
            errors.append(f"leaf reached with unresolved states {list(target)}")
        return not errors, errors
    if tree.symbol not in machine.inputs:
        errors.append(f"node applies unknown input {tree.symbol!r}")
        return False, errors
    groups: Dict[str, List[str]] = {}
    for state in target:
        nxt, out = machine.step(state, tree.symbol)
        groups.setdefault(out, []).append(nxt)
    for out, group in groups.items():
        if len(set(group)) != len(group):
            errors.append(
                f"input {tree.symbol!r} merges candidates into one successor on output {out!r}"
            )
            continue
        child = tree.children.get(out)
        if child is None:
            errors.append(f"missing branch for output {out!r} of states {group}")
            continue
        ok, sub_errors = verify_tree(machine, child, sorted(group))
        errors.extend(sub_errors)
    return not errors, errors


def label_leaves(machine: MealyMachine, tree: TreeNode, initial_states: Sequence[str]) -> None:
    """Label every leaf with the unique initial state whose trace ends there."""
    for state in initial_states:
        node = tree
        current = state
        while node.kind != "leaf":
            current, out = machine.step(current, node.symbol)
            node = node.children[out]
        node.state = state


def check_certificate(
    machine: MealyMachine,
    certificate: dict,
    states: Optional[Sequence[str]] = None,
) -> Tuple[bool, List[str]]:
    """Replay a certificate tree branch by branch.

    For every state a full root-to-leaf trace is simulated on the machine;
    each leaf must be reached by exactly one candidate state, and the
    traces of distinct states must differ.
    """
    errors: List[str] = []
    try:
        tree = TreeNode.from_dict(certificate)
    except (KeyError, TypeError) as exc:
        return False, [f"malformed certificate: {exc}"]
    target = list(states) if states is not None else list(machine.states)
    ok, structural = verify_tree(machine, tree, target)
    errors.extend(structural)

    traces: Dict[str, Tuple[Tuple[str, ...], Tuple[str, ...]]] = {}
    leaf_of: Dict[str, str] = {}
    for state in target:
        try:
            inputs, outputs, leaf_state = tree.trace(machine, state)
        except KeyError as exc:
            errors.append(f"state {state!r}: no branch for observed output {exc}")
            continue
        traces[state] = (tuple(inputs), tuple(outputs))
        leaf_of[state] = leaf_state
    for state, leaf_state in leaf_of.items():
        if leaf_state != state:
            errors.append(f"state {state!r} ends in leaf labelled {leaf_state!r}")
    for i, a in enumerate(target):
        for b in target[i + 1:]:
            if a in traces and b in traces and traces[a] == traces[b]:
                errors.append(f"states {a!r} and {b!r} share the same trace")
    return ok and not errors, errors
