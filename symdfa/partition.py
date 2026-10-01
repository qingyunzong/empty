"""Partition refinement for symbolic DFAs.

The inverse transition index is maintained by *interval events*: for every
edge ``p --ivset--> q`` and every interval ``(lo, hi)`` of ``ivset`` an event
record ``(lo, hi, p)`` is stored under target ``q``.  Characters are never
enumerated.
"""

from __future__ import annotations

from collections import deque
from typing import Dict, List, Optional, Sequence, Set, Tuple

from . import intervals as I
from .automaton import SymbolicDFA


DEAD = -1  # virtual sink node used by remerge


class StabilityError(RuntimeError):
    """Raised when a committed partition fails transition-stability checks."""


class InverseIndex:
    """target state -> sorted list of (lo, hi, predecessor) interval events."""

    def __init__(self) -> None:
        self.by_target: Dict[int, List[Tuple[int, int, int]]] = {}

    def add_state(self, dfa: SymbolicDFA, pred: int) -> None:
        for ivset, tgt in dfa.transitions[pred]:
            for lo, hi in ivset:
                self.by_target.setdefault(tgt, []).append((lo, hi, pred))
        for tgt in self.by_target:
            self.by_target[tgt].sort()

    def remove_state(self, pred: int) -> None:
        empty = []
        for tgt, events in self.by_target.items():
            kept = [e for e in events if e[2] != pred]
            if kept:
                self.by_target[tgt] = kept
            else:
                empty.append(tgt)
        for tgt in empty:
            del self.by_target[tgt]

    def predecessors(self, tgt: int) -> List[int]:
        return sorted({p for _lo, _hi, p in self.by_target.get(tgt, ())})

    def boundaries(self) -> List[int]:
        """Sorted interval-event boundary points across the whole index."""
        pts = set()
        for events in self.by_target.values():
            for lo, hi, _p in events:
                pts.add(lo)
                pts.add(hi + 1)
        return sorted(pts)

    def copy(self) -> "InverseIndex":
        other = InverseIndex()
        other.by_target = {t: list(ev) for t, ev in self.by_target.items()}
        return other


class Partition:
    """A refinable partition of the reachable states of a symbolic DFA."""

    def __init__(self, dfa: SymbolicDFA):
        self.dfa = dfa
        self.states: Set[int] = set(dfa.reachable_states())
        self.block_of: Dict[int, int] = {}
        self.blocks: Dict[int, Set[int]] = {}
        self._next_id = 0
        self.inverse = InverseIndex()
        for s in sorted(self.states):
            self.inverse.add_state(dfa, s)
        # initial split: final vs non-final
        for s in sorted(self.states):
            key = s in dfa.finals
            self._assign_initial(s, key)
        self.refine_all()
        self.remerge()

    # ------------------------------------------------------------------
    def _assign_initial(self, state: int, key: bool) -> None:
        for bid, members in self.blocks.items():
            if (next(iter(members)) in self.dfa.finals) == key:
                self.blocks[bid].add(state)
                self.block_of[state] = bid
                return
        bid = self._next_id
        self._next_id += 1
        self.blocks[bid] = {state}
        self.block_of[state] = bid

    def _new_block(self, members: Set[int]) -> int:
        bid = self._next_id
        self._next_id += 1
        self.blocks[bid] = set(members)
        for s in members:
            self.block_of[s] = bid
        return bid

    # ------------------------------------------------------------------
    def signature(self, state: int) -> tuple:
        """Canonical, edge-order-independent characterization of the
        char -> block behaviour of ``state``: interval sets are merged per
        target block, so equivalent edge splittings compare equal.  This is
        the interval-event form of the char-level successor function; no
        character is ever enumerated."""
        merged: Dict[int, tuple] = {}
        for ivset, tgt in self.dfa.transitions[state]:
            tb = self.block_of[tgt]
            merged[tb] = I.union(merged.get(tb, ()), ivset)
        return (
            state in self.dfa.finals,
            tuple(sorted((ivs, tb) for tb, ivs in merged.items())),
        )

    def _split(self, block: int) -> List[int]:
        """Split one block by signature; returns ids of new blocks."""
        members = self.blocks[block]
        if len(members) < 2:
            return []
        groups: Dict[tuple, Set[int]] = {}
        for s in sorted(members):
            groups.setdefault(self.signature(s), set()).add(s)
        if len(groups) == 1:
            return []
        keep_sig = self.signature(min(members))
        kept = groups[keep_sig]
        created: List[int] = []
        for sig, group in groups.items():
            if sig == keep_sig:
                continue
            created.append(self._new_block(group))
        self.blocks[block] = set(kept)
        return created

    def refine_all(self) -> None:
        """Refine to the coarsest stable partition (worklist algorithm)."""
        work: deque = deque(sorted(self.blocks))
        queued: Set[int] = set(self.blocks)
        while work:
            block = work.popleft()
            queued.discard(block)
            if block not in self.blocks or not self.blocks[block]:
                continue
            created = self._split(block)
            if not created:
                continue
            moved = [s for bid in created for s in self.blocks[bid]]
            # Blocks whose members have edges into moved states may have
            # changed signature: find them through the inverse index.
            affected: Set[int] = set(created) | {block}
            for s in moved:
                for pred in self.inverse.predecessors(s):
                    affected.add(self.block_of[pred])
            for bid in sorted(affected):
                if bid in self.blocks and bid not in queued:
                    work.append(bid)
                    queued.add(bid)

    def remerge(self) -> None:
        """Merge blocks that are equivalent under the current partition.

        Runs the refinement fixpoint one level up on the block-quotient
        graph, completed with a virtual DEAD node (the implicit sink for
        undefined characters).  Grouping blocks by finality and refining
        block-level signatures to a fixpoint yields exactly the
        Myhill-Nerode classes modulo the current (finer) partition, so
        merging the real blocks of each group gives the coarsest stable
        partition.  DEAD itself is virtual and never becomes a block."""
        bids = sorted(self.blocks)
        if len(bids) < 2:
            return
        sigma = self.dfa.alphabet_size

        # union edges per block: bid -> {target_bid: interval_set}
        bedges: Dict[int, Dict[int, tuple]] = {}
        for bid in bids:
            acc: Dict[int, tuple] = {}
            for s in self.blocks[bid]:
                for ivset, tgt in self.dfa.transitions[s]:
                    tb = self.block_of[tgt]
                    acc[tb] = I.union(acc.get(tb, ()), ivset)
            bedges[bid] = acc

        # initial grouping by finality; DEAD joins the non-final group
        groups: List[Set[int]] = []
        for want_final in (False, True):
            cls = {b for b in bids
                   if (min(self.blocks[b]) in self.dfa.finals) == want_final}
            if cls:
                groups.append(cls)
        groups[0].add(DEAD)  # first group is the non-final one
        group_of = {b: gid for gid, g in enumerate(groups) for b in g}

        def bsig(bid: int) -> tuple:
            if bid == DEAD:
                full = ((0, sigma - 1),)
                return (False, ((full, group_of[DEAD]),))
            acc: Dict[int, tuple] = {}
            for tb, ivs in bedges[bid].items():
                g = group_of[tb]
                acc[g] = I.union(acc.get(g, ()), ivs)
            # completion: undefined characters behave like DEAD
            cov: tuple = ()
            for ivs in acc.values():
                cov = I.union(cov, ivs)
            comp = I.complement(cov, sigma)
            if comp:
                gd = group_of[DEAD]
                acc[gd] = I.union(acc.get(gd, ()), comp)
            final = min(self.blocks[bid]) in self.dfa.finals
            return (final, tuple(sorted((ivs, g) for g, ivs in acc.items())))

        while True:
            changed = False
            new_groups: List[Set[int]] = []
            for g in groups:
                by_sig: Dict[tuple, Set[int]] = {}
                for bid in sorted(g):
                    by_sig.setdefault(bsig(bid), set()).add(bid)
                if len(by_sig) > 1:
                    changed = True
                new_groups.extend(by_sig.values())
            groups = new_groups
            group_of = {b: gid for gid, g in enumerate(groups) for b in g}
            if not changed:
                break

        for g in groups:
            real = sorted(b for b in g if b != DEAD)
            if len(real) < 2:
                continue
            keep = real[0]
            for other in real[1:]:
                for s in self.blocks.pop(other):
                    self.block_of[s] = keep
                    self.blocks[keep].add(s)

    # ------------------------------------------------------------------
    def verify_stability(self) -> List[str]:
        """Independent re-check that every block is transition-stable.

        Stability for a partial symbolic DFA means: inside a block, (1) all
        members agree on finality, (2) no character is sent to two
        different blocks by two members (union edges are deterministic),
        and (3) when a member is undefined on a character where the block
        has an edge to block B', then B' must be dead-equivalent (unable to
        reach any final block), so the undefined behaviour (reject) matches.
        Also re-checks inverse-index and block-map consistency."""
        errors: List[str] = []
        # finality homogeneity + union-edge determinism
        bedges: Dict[int, Dict[int, tuple]] = {}
        for bid in sorted(self.blocks):
            members = self.blocks[bid]
            if not members:
                errors.append(f"block {bid} is empty")
                continue
            finals = {s in self.dfa.finals for s in members}
            if len(finals) != 1:
                errors.append(f"block {bid} mixes final and non-final states")
            acc: Dict[int, tuple] = {}
            seen: tuple = ()
            for s in sorted(members):
                for ivset, tgt in self.dfa.transitions[s]:
                    tb = self.block_of[tgt]
                    overlap = I.intersect(seen, I.subtract(ivset, acc.get(tb, ())))
                    if overlap:
                        errors.append(
                            f"block {bid}: character(s) {overlap} sent to "
                            f"multiple blocks by different members"
                        )
                    acc[tb] = I.union(acc.get(tb, ()), ivset)
                    seen = I.union(seen, ivset)
            bedges[bid] = acc
        # dead-equivalence: blocks that can reach a final block
        final_blocks = {b for b in self.blocks
                        if min(self.blocks[b]) in self.dfa.finals}
        can_accept = set(final_blocks)
        changed = True
        while changed:
            changed = False
            for bid, acc in bedges.items():
                if bid in can_accept:
                    continue
                if any(tb in can_accept for tb in acc):
                    can_accept.add(bid)
                    changed = True
        # partial-consistency
        for bid in sorted(self.blocks):
            for s in sorted(self.blocks[bid]):
                cov: tuple = ()
                for ivset, _tgt in self.dfa.transitions[s]:
                    cov = I.union(cov, ivset)
                for tb, ivs in bedges[bid].items():
                    excess = I.subtract(ivs, cov)
                    if excess and tb in can_accept:
                        errors.append(
                            f"block {bid}: state {s} undefined on {excess} "
                            f"but block moves to live block {tb}"
                        )
        # inverse-index consistency
        fresh = InverseIndex()
        for s in sorted(self.states):
            fresh.add_state(self.dfa, s)
        if fresh.by_target != self.inverse.by_target:
            errors.append("inverse index out of sync with transitions")
        # block map consistency
        for s, bid in self.block_of.items():
            if s not in self.blocks.get(bid, ()):
                errors.append(f"state {s} missing from its block {bid}")
        return errors

    # ------------------------------------------------------------------
    def _snapshot(self) -> tuple:
        return (
            self.dfa,
            set(self.states),
            dict(self.block_of),
            {b: set(m) for b, m in self.blocks.items()},
            self._next_id,
            self.inverse.copy(),
        )

    def _restore(self, snap: tuple) -> None:
        (self.dfa, self.states, self.block_of, self.blocks,
         self._next_id, self.inverse) = snap

    def _sync_reachability(self, transitions_changed: bool) -> None:
        now = set(self.dfa.reachable_states())
        for s in sorted(self.states - now):
            bid = self.block_of.pop(s)
            self.blocks[bid].discard(s)
            if not self.blocks[bid]:
                del self.blocks[bid]
            if not transitions_changed:
                self.inverse.remove_state(s)
        for s in sorted(now - self.states):
            self._new_block({s})
            if not transitions_changed:
                self.inverse.add_state(self.dfa, s)
        self.states = now
        if transitions_changed:
            self.inverse = InverseIndex()
            for s in sorted(self.states):
                self.inverse.add_state(self.dfa, s)

    def apply_changes(
        self,
        finals: Optional[Sequence[int]] = None,
        transitions: Optional[Sequence] = None,
    ) -> None:
        """Batch-update finals and/or the transition table, then re-split and
        re-merge only the affected blocks.  On any failure (invalid input or
        a failed stability check) the previous partition and index are
        restored and the exception propagates."""
        snap = self._snapshot()
        try:
            if finals is not None or transitions is not None:
                self.dfa = SymbolicDFA(
                    self.dfa.alphabet_size,
                    self.dfa.num_states,
                    self.dfa.start,
                    finals if finals is not None else sorted(self.dfa.finals),
                    transitions if transitions is not None else self.dfa.transitions,
                )
            self._sync_reachability(transitions_changed=transitions is not None)
            self.refine_all()
            self.remerge()
            violations = self.verify_stability()
            if violations:
                raise StabilityError("; ".join(violations))
        except Exception:
            self._restore(snap)
            raise
