"""Deterministic automata over a finite minterm alphabet.

All engines share one alphabet: every character mentioned by any predicate,
the ``OTHER`` sentinel (any unmentioned ordinary character) and the
separator ``"/"``.  Equivalence and inclusion computed over these minterms
are exact for the symbolic semantics, not sampled.

Every construction takes a :class:`Budget`; when the state budget is
exhausted the partial result is returned together with the unexplored
frontier, which can be resumed later with a larger budget.
"""

from collections import deque

from .chars import OTHER, SEPARATOR


class Budget:
    """Shared state budget; exhaustion yields ``unknown`` outcomes."""

    def __init__(self, max_states=10000):
        self.max_states = max_states
        self.used = 0

    def claim(self):
        self.used += 1
        return self.used <= self.max_states


class DFA:
    def __init__(self, alphabet):
        self.alphabet = list(alphabet)
        self.trans = [{}]
        self.accepts = set()
        self.start = 0

    def add_state(self):
        self.trans.append({})
        return len(self.trans) - 1

    @property
    def num_states(self):
        return len(self.trans)

    def make_complete(self):
        dead = None
        for state in range(self.num_states):
            for sym in self.alphabet:
                if sym not in self.trans[state]:
                    if dead is None:
                        dead = self.add_state()
                        for a in self.alphabet:
                            self.trans[dead][a] = dead
                    self.trans[state][sym] = dead
        return self

    def complemented(self):
        self.make_complete()
        out = DFA(self.alphabet)
        out.trans = [dict(t) for t in self.trans]
        out.accepts = set(range(self.num_states)) - self.accepts
        return out

    def run(self, symbols):
        state = self.start
        for sym in symbols:
            nxt = self.trans[state].get(sym)
            if nxt is None:
                return False
            state = nxt
        return state in self.accepts


def _eps_closure(nfa, states):
    seen = set(states)
    stack = list(states)
    while stack:
        s = stack.pop()
        for sym, t in nfa.adj[s]:
            if sym is None and t not in seen:
                seen.add(t)
                stack.append(t)
    return seen


def _symbol_matches(nfa_sym, sym):
    if nfa_sym == SEPARATOR:
        return sym == SEPARATOR
    return nfa_sym.matches_symbol(sym)


class DeterminizeResult:
    def __init__(self, dfa, ids, frontier, done):
        self.dfa = dfa
        self.ids = ids
        self.frontier = frontier
        self.done = done

    def frontier_json(self):
        return [sorted(s) for s in self.frontier]


def determinize(nfa, alphabet, budget, resume=None):
    """Subset construction with a state budget.

    Returns a :class:`DeterminizeResult`; when ``done`` is false the
    ``frontier`` holds the unexpanded subsets and the whole result can be
    passed back as ``resume`` to continue with a fresh budget.
    """
    if resume is None:
        dfa = DFA(alphabet)
        start = frozenset(_eps_closure(nfa, {nfa.start}))
        ids = {start: dfa.start}
        if start & nfa.accepts:
            dfa.accepts.add(dfa.start)
        frontier = [start]
        budget.claim()
    else:
        dfa, ids, frontier = resume.dfa, resume.ids, list(resume.frontier)
    while frontier:
        current = frontier.pop()
        cur_id = ids[current]
        for sym in dfa.alphabet:
            nxt = set()
            for s in current:
                for nsym, t in nfa.adj[s]:
                    if nsym is not None and _symbol_matches(nsym, sym):
                        nxt.add(t)
            if not nxt:
                continue
            nxt = frozenset(_eps_closure(nfa, nxt))
            if nxt not in ids:
                if not budget.claim():
                    frontier.append(current)
                    return DeterminizeResult(dfa, ids, frontier, False)
                ids[nxt] = dfa.add_state()
                if nxt & nfa.accepts:
                    dfa.accepts.add(ids[nxt])
                frontier.append(nxt)
            dfa.trans[cur_id][sym] = ids[nxt]
    return DeterminizeResult(dfa, ids, frontier, True)


class ProductResult:
    def __init__(self, dfa, ids, parts, frontier, done):
        self.dfa = dfa
        self.ids = ids
        self.parts = parts
        self.frontier = frontier
        self.done = done

    def frontier_json(self):
        return [list(t) for t in self.frontier]


def product_multi(dfas, accept_fn, budget, resume=None):
    """On-the-fly product of complete DFAs over a shared alphabet.

    ``accept_fn`` maps the tuple of component accept flags to the product
    accept flag.  Budget exhaustion returns the resumable frontier.
    """
    if resume is None:
        dfa = DFA(dfas[0].alphabet)
        start = tuple(d.start for d in dfas)
        ids = {start: dfa.start}
        parts = [start]
        if accept_fn(tuple(d.start in d.accepts for d in dfas)):
            dfa.accepts.add(dfa.start)
        frontier = [start]
        budget.claim()
    else:
        dfa = resume.dfa
        ids = resume.ids
        parts = resume.parts
        frontier = list(resume.frontier)
    while frontier:
        current = frontier.pop()
        cur_id = ids[current]
        for sym in dfa.alphabet:
            nxt = tuple(dfas[k].trans[current[k]][sym] for k in range(len(dfas)))
            if nxt not in ids:
                if not budget.claim():
                    frontier.append(current)
                    return ProductResult(dfa, ids, parts, frontier, False)
                ids[nxt] = dfa.add_state()
                parts.append(nxt)
                flags = tuple(nxt[k] in dfas[k].accepts for k in range(len(dfas)))
                if accept_fn(flags):
                    dfa.accepts.add(ids[nxt])
                frontier.append(nxt)
            dfa.trans[cur_id][sym] = ids[nxt]
    return ProductResult(dfa, ids, parts, frontier, True)


def legal_dfa(alphabet):
    """DFA for the legal path language L: normalized relative paths.

    L = '' | seg ('/' seg)*  with seg = one or more ordinary characters.
    The root (empty string) is legal; empty segments, leading/trailing and
    consecutive separators are not.
    """
    dfa = DFA(alphabet)
    in_seg = dfa.add_state()
    after_sep = dfa.add_state()
    dead = dfa.add_state()
    dfa.accepts = {dfa.start, in_seg}
    ordinary = [a for a in alphabet if a != SEPARATOR]
    for a in ordinary:
        dfa.trans[dfa.start][a] = in_seg
        dfa.trans[in_seg][a] = in_seg
        dfa.trans[after_sep][a] = in_seg
        dfa.trans[dead][a] = dead
    dfa.trans[dfa.start][SEPARATOR] = after_sep
    dfa.trans[in_seg][SEPARATOR] = after_sep
    dfa.trans[after_sep][SEPARATOR] = dead
    dfa.trans[dead][SEPARATOR] = dead
    return dfa


def empty_dfa(alphabet):
    return DFA(alphabet).make_complete()


def shortest_accept_paths(dfa, all_paths=False, limit=100):
    """BFS for shortest paths from the start to any accepting state.

    Returns a list of symbol tuples.  With ``all_paths`` every shortest
    path (up to ``limit``) is returned, which enumerates multiple
    same-length counterexamples.
    """
    best = {dfa.start: 0}
    queue = deque([(dfa.start, ())])
    found = []
    found_depth = None
    while queue:
        state, path = queue.popleft()
        if found_depth is not None and len(path) > found_depth:
            break
        if state in dfa.accepts:
            found.append(path)
            found_depth = len(path)
            if not all_paths or len(found) >= limit:
                break
            continue
        depth = len(path) + 1
        for sym in dfa.alphabet:
            nxt = dfa.trans[state].get(sym)
            if nxt is None:
                continue
            seen = best.get(nxt)
            if seen is not None and seen < depth:
                continue
            best[nxt] = depth
            queue.append((nxt, path + (sym,)))
    return found
