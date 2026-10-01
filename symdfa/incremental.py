"""Incremental partition maintenance with transactional commits.

A batch of finality / transition changes is applied as follows:

1. snapshot the old DFA, inverse index, partition and result,
2. build the new DFA (interval validation happens here, before any state
   is mutated) and update the inverse index incrementally per changed
   source state,
3. split phase: relocate finality-changed states into singleton blocks and
   run worklist refinement seeded with the affected blocks only,
4. merge phase: minimize the quotient of the resulting partition so blocks
   that became equivalent again are re-merged,
5. validation: every block must be finality-uniform and transition-stable
   (plus any caller-supplied validator); on failure the old partition and
   index are restored and ``ValidationError`` is raised.
"""
from __future__ import annotations

from .dfa import InverseIndex, SymbolicDFA, reachable
from .minimize import (
    Partition,
    build_result,
    initial_partition,
    quotient_dfa,
    refine,
    validate_partition,
)


class ValidationError(Exception):
    """Raised when post-update validation fails; changes are rolled back."""


def _merge_phase(dfa, partition):
    """Re-merge blocks that are equivalent again after an update.

    The split phase only refines, so it can leave the partition finer than
    the Myhill-Nerode partition.  Minimizing the quotient of the current
    (stable) partition yields exactly the coarsest partition.
    """
    if len(partition.blocks) <= 1:
        return partition
    quotient = quotient_dfa(dfa, partition)
    qpartition = refine(
        quotient,
        InverseIndex.build(quotient),
        initial_partition(quotient, set(quotient.states)),
    )
    if len(qpartition.blocks) == len(partition.blocks):
        return partition
    merged = {}
    for index, block in enumerate(partition.blocks):
        merged.setdefault(qpartition.block_of[index], set()).update(block)
    return Partition(merged.values())


class IncrementalMinimizer:
    """Maintains a minimal partition across batches of DFA updates."""

    def __init__(self, dfa):
        self.dfa = dfa
        self.inv = InverseIndex.build(dfa)
        self.reach = reachable(dfa)
        self.partition = refine(
            self.dfa, self.inv, initial_partition(self.dfa, self.reach)
        )
        self.result = build_result(self.dfa, self.reach, self.partition)

    def apply_updates(self, final_changes=None, transition_changes=None,
                      validator=None):
        """Apply a batch of changes; roll back fully on validation failure.

        ``validator`` is an optional callable receiving the minimizer after
        the commit is staged; returning a falsy value forces a rollback.
        """
        final_changes = {
            int(s): bool(v) for s, v in (final_changes or {}).items()
        }
        transition_changes = {
            int(s): rows for s, rows in (transition_changes or {}).items()
        }
        snapshot = (self.dfa, self.inv, self.partition, self.reach, self.result)
        try:
            finals = set(self.dfa.finals)
            for state, is_final in final_changes.items():
                (finals.add if is_final else finals.discard)(state)
            transitions = dict(self.dfa.transitions)
            transitions.update(transition_changes)
            new_dfa = SymbolicDFA(
                self.dfa.alphabet_size, self.dfa.start, finals, transitions
            )
            new_inv = self.inv.copy()
            for state in transition_changes:
                new_inv.replace_source(state, new_dfa.transitions[state])
            reach = reachable(new_dfa)
            changed = (set(final_changes) | set(transition_changes)) & reach
            if reach != self.reach:
                # Reachability changed: re-refine from the canonical seed.
                partition = refine(
                    new_dfa, new_inv, initial_partition(new_dfa, reach)
                )
            else:
                blocks = [set(b) for b in self.partition.blocks]
                for state in changed:
                    if state in final_changes:
                        blocks[self.partition.block_of[state]].discard(state)
                        blocks.append({state})
                partition = Partition(blocks)
                seed = sorted({partition.block_of[s] for s in changed})
                partition = refine(
                    new_dfa,
                    new_inv,
                    partition,
                    [frozenset(partition.blocks[i]) for i in seed],
                )
                if not validate_partition(new_dfa, partition):
                    # Partial seeding was not enough: refine with the full
                    # worklist before giving up.
                    partition = refine(new_dfa, new_inv, partition)
            partition = _merge_phase(new_dfa, partition)
            result = build_result(new_dfa, reach, partition)
            self.dfa = new_dfa
            self.inv = new_inv
            self.reach = reach
            self.partition = partition
            self.result = result
            if validator is not None and not validator(self):
                raise ValidationError("custom validator rejected the update")
            if not validate_partition(self.dfa, self.partition):
                raise ValidationError(
                    "transition stability check failed; rolled back"
                )
        except Exception:
            (self.dfa, self.inv, self.partition,
             self.reach, self.result) = snapshot
            raise
        return self.result
