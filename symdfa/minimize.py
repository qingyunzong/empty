"""Partition-refinement minimization for symbolic DFAs.

The refiner works on a worklist of splitter blocks.  For each splitter it
walks the inverse transition index (interval events, never characters) to
compute, per source state, the exact character set that lands in the
splitter, and splits blocks whose members disagree on that set.
"""
from __future__ import annotations

from collections import deque

from .dfa import InverseIndex, SymbolicDFA, merge_intervals, reachable
from .proof import build_proof_dag
from .serialize import dfa_to_json


class Partition:
    """A set partition over DFA states with a state -> block index map."""

    def __init__(self, blocks):
        self.blocks = []
        self.block_of = {}
        for block in blocks:
            block = frozenset(block)
            if not block:
                continue
            index = len(self.blocks)
            self.blocks.append(block)
            for state in block:
                self.block_of[state] = index

    def __eq__(self, other):
        return (
            isinstance(other, Partition)
            and set(self.blocks) == set(other.blocks)
        )

    def __repr__(self):
        return f"Partition({sorted(sorted(b) for b in self.blocks)})"


def initial_partition(dfa, reach):
    """The canonical seed: reachable finals vs. reachable non-finals."""
    finals = [s for s in sorted(reach) if s in dfa.finals]
    nonfinals = [s for s in sorted(reach) if s not in dfa.finals]
    return Partition([frozenset(finals), frozenset(nonfinals)])


def refine(dfa, inv, partition, worklist=None):
    """Refine ``partition`` until stable w.r.t. the DFA transitions.

    ``worklist`` is an optional seed of splitter blocks (frozensets of
    states); when omitted every current block is used.  Splitting only ever
    separates states that some union of current blocks distinguishes, so the
    result is always a bisimulation that refines the Myhill-Nerode partition.
    """
    blocks = [set(b) for b in partition.blocks]
    block_of = dict(partition.block_of)
    if worklist is None:
        worklist = [frozenset(b) for b in blocks]
    else:
        worklist = list(worklist)
    while worklist:
        splitter = worklist.pop()
        # Preimage of the splitter via the inverse index: for each source
        # state, the exact char set (merged interval events) hitting it.
        preimage = {}
        for target in splitter:
            for lo, hi, src in inv.by_target.get(target, ()):
                if src in block_of:
                    preimage.setdefault(src, []).append((lo, hi))
        per_block = {}
        for src, events in preimage.items():
            per_block.setdefault(block_of[src], {})[src] = merge_intervals(events)
        for block_index, signatures in per_block.items():
            block = blocks[block_index]
            groups = {}
            for state in block:
                groups.setdefault(signatures.get(state, ()), []).append(state)
            if len(groups) <= 1:
                continue
            # Deterministic split: order new groups by their smallest state.
            new_groups = sorted(groups.values(), key=lambda g: min(g))
            blocks[block_index] = set(new_groups[0])
            for state in new_groups[0]:
                block_of[state] = block_index
            for group in new_groups[1:]:
                blocks.append(set(group))
                new_index = len(blocks) - 1
                for state in group:
                    block_of[state] = new_index
                worklist.append(frozenset(group))
            worklist.append(frozenset(new_groups[0]))
    return Partition(blocks)


def block_signature(dfa, state, block_of):
    """(finality, merged (lo, hi, target-block) rows) for a state."""
    rows = []
    for lo, hi, target in dfa.transitions[state]:
        block = block_of[target]
        if rows and rows[-1][2] == block and rows[-1][1] == lo - 1:
            rows[-1] = (rows[-1][0], hi, block)
        else:
            rows.append((lo, hi, block))
    return (state in dfa.finals, tuple(rows))


def validate_partition(dfa, partition):
    """Check finality uniformity and transition stability of every block."""
    for block in partition.blocks:
        members = sorted(block)
        reference = block_signature(dfa, members[0], partition.block_of)
        for state in members[1:]:
            if block_signature(dfa, state, partition.block_of) != reference:
                return False
    return True


def quotient_dfa(dfa, partition):
    """Quotient DFA whose states are block indices (representative rows)."""
    transitions = {}
    for index, block in enumerate(partition.blocks):
        rep = min(block)
        rows = []
        for lo, hi, target in dfa.transitions[rep]:
            tblock = partition.block_of[target]
            if rows and rows[-1][2] == tblock and rows[-1][1] == lo - 1:
                rows[-1] = (rows[-1][0], hi, tblock)
            else:
                rows.append((lo, hi, tblock))
        transitions[index] = rows
    finals = [
        i for i, block in enumerate(partition.blocks)
        if min(block) in dfa.finals
    ]
    return SymbolicDFA(
        dfa.alphabet_size, partition.block_of[dfa.start], finals, transitions
    )


def canonicalize(qdfa):
    """Renumber quotient states by lexicographic shortest reaching word.

    BFS from the start state, expanding each state's intervals in ascending
    ``lo`` order, assigns 0, 1, 2, ... deterministically -- independent of
    input state naming or set iteration order.
    """
    order = {qdfa.start: 0}
    queue = deque([qdfa.start])
    while queue:
        state = queue.popleft()
        for _, _, target in qdfa.transitions[state]:
            if target not in order:
                order[target] = len(order)
                queue.append(target)
    transitions = {
        order[s]: [(lo, hi, order[t]) for lo, hi, t in qdfa.transitions[s]]
        for s in order
    }
    finals = sorted(order[f] for f in qdfa.finals)
    canon = SymbolicDFA(qdfa.alphabet_size, 0, finals, transitions)
    return canon, order


class MinimizationResult:
    """Canonical quotient automaton + state mapping + proof DAG."""

    def __init__(self, automaton, state_to_block, blocks, proof):
        self.automaton = automaton
        self.state_to_block = state_to_block
        self.blocks = blocks
        self.proof = proof

    def to_dict(self):
        return {
            "alphabet_size": self.automaton.alphabet_size,
            "automaton": dfa_to_json(self.automaton),
            "blocks": [list(b) for b in self.blocks],
            "state_to_block": {
                str(s): b for s, b in sorted(self.state_to_block.items())
            },
            "proof_dag": self.proof.to_dict(),
        }


def build_result(dfa, reach, partition):
    """Assemble the canonical output for a stable partition."""
    canon, order = canonicalize(quotient_dfa(dfa, partition))
    blocks = [[] for _ in partition.blocks]
    for index, block in enumerate(partition.blocks):
        blocks[order[index]] = sorted(block)
    state_to_block = {s: None for s in dfa.states}
    for canon_id, members in enumerate(blocks):
        for state in members:
            state_to_block[state] = canon_id
    proof = build_proof_dag(canon)
    return MinimizationResult(canon, state_to_block, blocks, proof)


def minimize(dfa):
    """Trim unreachable states, then refine finals/non-finals to fixpoint."""
    reach = reachable(dfa)
    inv = InverseIndex.build(dfa)
    partition = refine(dfa, inv, initial_partition(dfa, reach))
    return build_result(dfa, reach, partition)
