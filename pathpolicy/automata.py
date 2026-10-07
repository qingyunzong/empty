"""Symbolic finite automata over character-set predicates.

The alphabet is the (infinite) set of unicode characters.  NFA transitions
are labelled with CharSet predicates.  All predicates that occur in a
product are refined into *minterms* (atoms of the Venn diagram), so
determinization, products, complements and emptiness checks are exact set
operations -- never sampling.  Every atom is either a finite set of
characters or the REST atom (all characters not mentioned anywhere), which
is infinite and therefore always non-empty.
"""

from collections import deque


class CharSet:
    """A character predicate: a finite set, or its complement."""

    __slots__ = ("chars", "negated")

    def __init__(self, chars, negated=False):
        self.chars = frozenset(chars)
        self.negated = bool(negated)

    def contains(self, c):
        return (c in self.chars) != self.negated

    def __eq__(self, other):
        return (isinstance(other, CharSet) and self.chars == other.chars
                and self.negated == other.negated)

    def __hash__(self):
        return hash((self.chars, self.negated))

    def __repr__(self):
        return "CharSet(%r, negated=%r)" % (sorted(self.chars), self.negated)

    def to_json(self):
        return {"chars": sorted(self.chars), "negated": self.negated}

    @staticmethod
    def from_json(d):
        return CharSet(d["chars"], d["negated"])


_SAMPLE_ORDER = ("abcdefghijklmnopqrstuvwxyz"
                 "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                 "0123456789")


class Minterm:
    """One atom of the predicate partition.

    ``chars`` is a frozenset for a finite atom, or None for the REST atom
    (every character not in ``rest_excludes``).
    """

    __slots__ = ("chars", "rest_excludes")

    def __init__(self, chars, rest_excludes=None):
        self.chars = chars
        self.rest_excludes = rest_excludes

    @property
    def is_rest(self):
        return self.chars is None

    def sample(self):
        """Return one concrete character of this atom (deterministic)."""
        if self.chars is not None:
            return min(self.chars)
        for c in _SAMPLE_ORDER:
            if c not in self.rest_excludes:
                return c
        cp = 33
        while chr(cp) in self.rest_excludes:
            cp += 1
        return chr(cp)

    def to_json(self):
        if self.is_rest:
            return {"rest": True, "excludes": sorted(self.rest_excludes)}
        return {"chars": sorted(self.chars)}


def compute_minterms(predicates):
    """Partition the alphabet into atoms for the given predicates."""
    predicates = list(predicates)
    finite_union = set()
    for p in predicates:
        finite_union |= p.chars
    groups = {}
    for c in sorted(finite_union):
        sig = tuple(p.contains(c) for p in predicates)
        groups.setdefault(sig, set()).add(c)
    minterms = [Minterm(frozenset(s)) for s in groups.values()]
    minterms.append(Minterm(None, frozenset(finite_union)))
    return minterms


class NFA:
    """Epsilon NFA whose transitions carry CharSet predicates."""

    def __init__(self):
        self.num_states = 0
        self.start = self.add_state()
        self.accepting = set()
        self.transitions = []
        self.epsilons = []

    def add_state(self):
        sid = self.num_states
        self.num_states += 1
        return sid

    def add_transition(self, src, charset, dst):
        self.transitions.append((src, charset, dst))

    def add_epsilon(self, src, dst):
        self.epsilons.append((src, dst))

    def epsilon_closures(self):
        adj = {}
        for (s, d) in self.epsilons:
            adj.setdefault(s, []).append(d)
        closures = []
        for s in range(self.num_states):
            seen = {s}
            stack = [s]
            while stack:
                cur = stack.pop()
                for nxt in adj.get(cur, ()):
                    if nxt not in seen:
                        seen.add(nxt)
                        stack.append(nxt)
            closures.append(frozenset(seen))
        return closures

    def accepts_string(self, s):
        """Simulate the NFA on a concrete string (independent of products)."""
        closures = self.epsilon_closures()
        current = closures[self.start]
        for c in s:
            nxt = set()
            for (src, cs, dst) in self.transitions:
                if src in current and cs.contains(c):
                    nxt.add(dst)
            current = set()
            for d in nxt:
                current |= closures[d]
            current = frozenset(current)
        return not current.isdisjoint(self.accepting)

    @staticmethod
    def union(nfas):
        out = NFA()
        for nfa in nfas:
            off = out.num_states
            for _ in range(nfa.num_states):
                out.add_state()
            for (s, cs, d) in nfa.transitions:
                out.add_transition(s + off, cs, d + off)
            for (s, d) in nfa.epsilons:
                out.add_epsilon(s + off, d + off)
            out.accepting |= {s + off for s in nfa.accepting}
            out.add_epsilon(out.start, nfa.start + off)
        return out

    def to_json(self):
        return {
            "num_states": self.num_states,
            "start": self.start,
            "accepting": sorted(self.accepting),
            "transitions": [
                {"src": s, "dst": d, "set": cs.to_json()}
                for (s, cs, d) in self.transitions
            ],
            "epsilons": [[s, d] for (s, d) in self.epsilons],
        }

    @staticmethod
    def from_json(d):
        nfa = NFA()
        for _ in range(d["num_states"] - 1):
            nfa.add_state()
        nfa.start = d["start"]
        nfa.accepting = set(d["accepting"])
        for t in d["transitions"]:
            nfa.add_transition(t["src"], CharSet.from_json(t["set"]), t["dst"])
        for (s, dd) in d["epsilons"]:
            nfa.add_epsilon(s, dd)
        return nfa


class ProductMachine:
    """Deterministic product of subset constructions over shared minterms.

    A product state is a tuple of frozensets (one per component NFA).
    ``accept_fn`` receives a list of booleans, one per component, telling
    whether that component's subset contains an accepting NFA state; this
    is how boolean combinations (union, difference, complement relative to
    the legal-path language) are expressed exactly.
    """

    def __init__(self, nfas, accept_fn):
        self.nfas = list(nfas)
        self.accept_fn = accept_fn
        predicates = []
        seen = set()
        for nfa in self.nfas:
            for (_, cs, _) in nfa.transitions:
                if cs not in seen:
                    seen.add(cs)
                    predicates.append(cs)
        self.minterms = compute_minterms(predicates)
        self._samples = [m.sample() for m in self.minterms]
        self.closures = [nfa.epsilon_closures() for nfa in self.nfas]
        self.moves = []
        for nfa in self.nfas:
            by_src = {}
            for (s, cs, d) in nfa.transitions:
                by_src.setdefault(s, []).append((cs, d))
            table = []
            for s in range(nfa.num_states):
                trans = by_src.get(s, ())
                row = []
                for sample in self._samples:
                    row.append(frozenset(d for (cs, d) in trans
                                         if cs.contains(sample)))
                table.append(row)
            self.moves.append(table)

    def start_state(self):
        return tuple(self.closures[i][self.nfas[i].start]
                     for i in range(len(self.nfas)))

    def step(self, state, mi):
        out = []
        for i, subset in enumerate(state):
            acc = set()
            table = self.moves[i]
            closures = self.closures[i]
            for s in subset:
                for d in table[s][mi]:
                    acc |= closures[d]
            out.append(frozenset(acc))
        return tuple(out)

    def accepts(self, state):
        flags = [not subset.isdisjoint(self.nfas[i].accepting)
                 for i, subset in enumerate(state)]
        return self.accept_fn(flags)


class Exploration:
    """Breadth-first exploration of a ProductMachine with a state budget.

    The frontier (unexpanded product states) plus all parent links are
    serializable, so an exhausted run can be resumed later with a larger
    budget.
    """

    def __init__(self, machine):
        self.machine = machine
        self._order = sorted(range(len(machine.minterms)),
                             key=lambda i: machine.minterms[i].sample())
        self.states = []
        self.ids = {}
        self.depth = []
        self.parents = {}
        self.transitions = []
        self.frontier = deque()
        start = machine.start_state()
        self._intern(start, None)

    def _intern(self, state, parent_idx):
        idx = self.ids.get(state)
        if idx is None:
            idx = len(self.states)
            self.ids[state] = idx
            self.states.append(state)
            self.depth.append(0 if parent_idx is None
                              else self.depth[parent_idx] + 1)
            self.parents[idx] = []
            self.frontier.append(idx)
        return idx

    def run(self, budget, all_shortest=False, witness_limit=32):
        """Explore until empty, a witness is found, or the budget runs out.

        Returns ("empty", None) | ("found", [witness, ...]) |
        ("exhausted", None).  ``budget`` bounds the total number of product
        states created.
        """
        machine = self.machine
        found = []
        found_depth = None
        while self.frontier:
            if len(self.states) > budget:
                return ("exhausted", None)
            idx = self.frontier.popleft()
            state = self.states[idx]
            if found_depth is not None and self.depth[idx] > found_depth:
                break
            if machine.accepts(state):
                if found_depth is None:
                    found_depth = self.depth[idx]
                found.append(idx)
                if not all_shortest:
                    return ("found", [self._witness(idx)])
                continue
            if found_depth is not None:
                continue
            for mi in self._order:
                tgt = machine.step(state, mi)
                tidx = self._intern(tgt, idx)
                self.parents[tidx].append((idx, mi))
                self.transitions.append((idx, mi, tidx))
        if found:
            out = []
            for idx in found:
                if len(out) >= witness_limit:
                    break
                out.extend(self._all_witnesses(idx, witness_limit - len(out)))
            return ("found", out)
        return ("empty", None)

    def _witness(self, idx):
        chars = []
        while self.parents[idx]:
            (p, mi) = self.parents[idx][0]
            chars.append(self.machine._samples[mi])
            idx = p
        return "".join(reversed(chars))

    def _minterm_chars(self, mi):
        m = self.machine.minterms[mi]
        if m.is_rest:
            return [m.sample()]
        return sorted(m.chars)

    def _all_witnesses(self, idx, limit):
        results = []

        def rec(i, suffix):
            if len(results) >= limit:
                return
            ps = self.parents[i]
            if not ps:
                results.append("".join(suffix))
                return
            for (p, mi) in ps:
                for c in self._minterm_chars(mi):
                    rec(p, [c] + suffix)
                    if len(results) >= limit:
                        return

        rec(idx, [])
        return results

    def to_json(self):
        return {
            "states": [[sorted(sub) for sub in st] for st in self.states],
            "depth": list(self.depth),
            "parents": {str(i): [[p, mi] for (p, mi) in ps]
                        for i, ps in self.parents.items()},
            "frontier": list(self.frontier),
            "transitions": [[s, mi, t] for (s, mi, t) in self.transitions],
        }

    def load_json(self, d):
        self.states = [tuple(frozenset(sub) for sub in st)
                       for st in d["states"]]
        self.ids = {st: i for i, st in enumerate(self.states)}
        self.depth = list(d["depth"])
        self.parents = {int(i): [tuple(pair) for pair in ps]
                        for i, ps in d["parents"].items()}
        self.frontier = deque(d["frontier"])
        self.transitions = [tuple(t) for t in d["transitions"]]
