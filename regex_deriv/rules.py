"""Named rule set with dependency-tracked caching.

Each named rule maps to a parsed expression and carries a version counter.
Derived results (automata, equivalence/inclusion/difference queries) are
cached together with the set of rule names they depend on.  Re-defining a
rule bumps its version and eagerly invalidates exactly those cache entries
that depend on it; entries for unrelated rules survive (no cache
pollution)."""
from __future__ import annotations

from . import algebra
from .automaton import build_dfa, minimize
from .parser import parse
from .syntax import Node, from_raw


class RuleSet:
    def __init__(self, alphabet):
        self.alphabet = alphabet
        self._rules = {}
        self._versions = {}
        self._cache = {}  # key -> (deps: frozenset, value)
        self.hits = 0
        self.misses = 0
        self.invalidated = 0

    def set(self, name, pattern):
        """Define or redefine a rule; invalidates dependent cache entries."""
        if isinstance(pattern, Node):
            node = pattern
        else:
            node = from_raw(parse(pattern, self.alphabet))
        self._rules[name] = node
        self._versions[name] = self._versions.get(name, 0) + 1
        doomed = [k for k, (deps, _) in self._cache.items() if name in deps]
        for k in doomed:
            del self._cache[k]
            self.invalidated += 1

    def get(self, name):
        return self._rules[name]

    def version(self, name):
        return self._versions.get(name, 0)

    def _cached(self, op, names, fn):
        key = (op, tuple(sorted((n, self._versions[n]) for n in names)))
        ent = self._cache.get(key)
        if ent is not None:
            self.hits += 1
            return ent[1]
        value = fn()
        self._cache[key] = (frozenset(names), value)
        self.misses += 1
        return value

    def automaton(self, name, max_states=None):
        return self._cached(
            "automaton", (name,),
            lambda: minimize(
                build_dfa(self._rules[name], self.alphabet, max_states),
                self.alphabet))

    def equivalent(self, a, b, **kw):
        return self._cached(
            "equivalent", (a, b),
            lambda: algebra.equivalent(
                self._rules[a], self._rules[b], self.alphabet, **kw))

    def included(self, a, b, **kw):
        return self._cached(
            "included", (a, b),
            lambda: algebra.included(
                self._rules[a], self._rules[b], self.alphabet, **kw))

    def shortest_difference(self, a, b, **kw):
        return self._cached(
            "shortest_difference", (a, b),
            lambda: algebra.shortest_difference(
                self._rules[a], self._rules[b], self.alphabet, **kw))

    def match(self, name, s):
        return algebra.match(self._rules[name], s, self.alphabet)
