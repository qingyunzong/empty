"""Incremental forward-chaining rule engine with negation-as-failure.

Rules have the form ``head :- a, b, not c``. Facts are either *base*
(asserted by the user) or *derived* (produced by a rule). The engine
maintains a reverse dependency map (fact -> rules mentioning it in the
body) so that retractions only invalidate the derivations that actually
depend on the removed fact.
"""

from __future__ import annotations

import re

ATOM_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
NOT_RE = re.compile(r"not\s+(.+)")


class RuleSyntaxError(Exception):
    """Raised when a rule or command argument cannot be parsed."""


class AssertDerivedError(Exception):
    """Raised when trying to assert a fact that is currently derived."""


class Rule:
    __slots__ = ("rid", "head", "pos", "neg")

    def __init__(self, rid, head, pos, neg):
        self.rid = rid
        self.head = head
        self.pos = tuple(pos)
        self.neg = tuple(neg)

    def __repr__(self):
        body = ", ".join(list(self.pos) + [f"not {n}" for n in self.neg])
        return f"Rule({self.rid}: {self.head} :- {body})"


def parse_atom(text):
    text = text.strip()
    if not ATOM_RE.fullmatch(text):
        raise RuleSyntaxError(f"invalid atom: {text!r}")
    return text


def parse_rule(text, rid):
    text = text.strip()
    if ":-" not in text:
        raise RuleSyntaxError(f"rule must contain ':-': {text!r}")
    head_text, body_text = text.split(":-", 1)
    head = parse_atom(head_text)
    pos, neg = [], []
    body_text = body_text.strip()
    if body_text:
        for part in body_text.split(","):
            part = part.strip()
            if not part:
                raise RuleSyntaxError(f"empty body atom in rule: {text!r}")
            match = NOT_RE.fullmatch(part)
            if match:
                neg.append(parse_atom(match.group(1)))
            elif part == "not":
                raise RuleSyntaxError(f"dangling 'not' in rule: {text!r}")
            else:
                pos.append(parse_atom(part))
    return Rule(rid, head, pos, neg)


class Engine:
    """Incremental rule engine.

    Invariants:
      - ``self.facts`` = base facts ∪ currently valid derived facts.
      - ``self.proofs[f]`` = set of proofs for ``f``; a proof is
        ``(rule_id, frozenset(positive_antecedents))`` and is valid iff
        every positive antecedent is a current fact and every negative
        antecedent of the rule is absent.
      - A non-base fact is in ``self.facts`` iff it has ≥1 valid proof.
    """

    MAX_REPAIR_ROUNDS = 1000  # hard cap: guarantees termination (req 5)

    def __init__(self):
        self.base = set()
        self.rules = []          # ordered by ascending rule id
        self.facts = set()
        self.proofs = {}
        self.pos_users = {}      # fact -> {rule ids with fact in positive body}
        self.neg_users = {}      # fact -> {rule ids with fact in negative body}

    # ------------------------------------------------------------------ queries
    def holds(self, fact):
        return fact in self.facts

    def is_derived(self, fact):
        return fact in self.facts and fact not in self.base

    # ------------------------------------------------------------------ commands
    def add_rule(self, text):
        rule = parse_rule(text, len(self.rules))
        self.rules.append(rule)
        for atom in rule.pos:
            self.pos_users.setdefault(atom, set()).add(rule.rid)
        for atom in rule.neg:
            self.neg_users.setdefault(atom, set()).add(rule.rid)
        self._repair(set())
        return rule.rid

    def assert_fact(self, fact):
        if self.is_derived(fact):
            raise AssertDerivedError(fact)
        if fact in self.base:
            return
        self.base.add(fact)
        self.facts.add(fact)
        # A new fact may invalidate proofs via 'not' bodies, then enable
        # new derivations.
        self._repair({fact})

    def retract_fact(self, fact):
        if fact not in self.base:
            return  # retracting a derived or unknown fact is a no-op
        self.base.discard(fact)
        self.proofs.pop(fact, None)
        self.facts.discard(fact)
        # If the fact is still derivable, the saturation phase of the
        # repair re-derives it (as a derived fact).
        self._repair({fact})

    # ------------------------------------------------------------------ internals
    def _cascade_delete(self, dirty):
        """Invalidate derivations affected by ``dirty`` facts (DRed).

        Two kinds of dirty facts:
          - present facts (just asserted or just derived): may invalidate
            proofs through 'not' bodies. Those proofs are pruned and any
            head that lost a proof becomes a seed.
          - absent facts (just retracted or deleted): seeds themselves.

        From the seeds, every derived fact reachable through positive
        proof dependencies (via the reverse dependency map) is
        over-deleted; the saturation phase then re-derives exactly those
        facts that still have a well-founded proof. This is what makes
        cyclic self-supporting proof sets collapse correctly.
        """
        seeds = set()
        for fact in dirty:
            if fact not in self.facts:
                seeds.add(fact)  # removed fact: dependents may be doomed
                continue
            # Present fact: prune proofs killed by its arrival ('not').
            for rid in sorted(self.neg_users.get(fact, ())):
                head = self.rules[rid].head
                if head not in self.proofs:
                    continue
                pruned = {p for p in self.proofs[head] if p[0] != rid}
                if len(pruned) != len(self.proofs[head]):
                    self.proofs[head] = pruned
                    if head not in self.base:
                        seeds.add(head)
        # Over-delete: derived facts positively reachable from seeds.
        victims = set()
        stack = []
        for seed in seeds:
            if seed not in self.base:
                stack.append(seed)
                if seed in self.facts:
                    victims.add(seed)
        while stack:
            gone = stack.pop()
            for rid in self.pos_users.get(gone, ()):
                head = self.rules[rid].head
                if (
                    head in self.base
                    or head in victims
                    or head not in self.facts
                ):
                    continue
                if any(p[0] == rid for p in self.proofs.get(head, ())):
                    victims.add(head)
                    stack.append(head)
        for victim in victims:
            self.proofs.pop(victim, None)
            self.facts.discard(victim)

    def _saturate(self):
        """Forward-chain to a fixpoint.

        Each round evaluates rules in ascending rule id order; newly
        derived facts of a round are applied in lexicographic order, so
        the result is deterministic. Returns facts added during the call.
        """
        added = []
        while True:
            new = []
            for rule in self.rules:  # ascending rule id
                if not all(p in self.facts for p in rule.pos):
                    continue
                if any(n in self.facts for n in rule.neg):
                    continue
                proof = (rule.rid, frozenset(rule.pos))
                if proof not in self.proofs.get(rule.head, ()):
                    new.append((rule.head, proof))
            if not new:
                return added
            for head, proof in sorted(new):  # lexicographic fact order
                self.proofs.setdefault(head, set()).add(proof)
                if head not in self.facts:
                    self.facts.add(head)
                    added.append(head)

    def _repair(self, dirty):
        """Restore invariants after a change.

        Alternates deletion (invalidated proofs) and saturation (new
        derivations, possibly enabled by 'not' bodies) until stable.
        The round cap guarantees termination even for rules like
        ``p :- not p`` that admit no stable model.
        """
        for _ in range(self.MAX_REPAIR_ROUNDS):
            if dirty:
                self._cascade_delete(dirty)
            added = self._saturate()
            if not added:
                return
            dirty = added


def naive_closure(base, rules):
    """Reference implementation: perfect model of a stratified program.

    Computes strongly connected components of the positive dependency
    graph and saturates them in topological order, so every derived fact
    is well-foundedly supported by the base facts and negative literals
    are only evaluated against already-final strata. Raises ValueError
    for unstratified programs (a 'not' edge inside a positive cycle).
    Used by the randomized test to cross-check the incremental engine.
    """
    pos_deps = {}
    preds = set(base)
    for rule in rules:
        preds.add(rule.head)
        preds.update(rule.pos)
        preds.update(rule.neg)
    for pred in preds:
        pos_deps[pred] = set()
    for rule in rules:
        pos_deps[rule.head].update(rule.pos)

    # Tarjan's SCC algorithm (recursive; predicate universes are small).
    index_of = {}
    lowlink = {}
    on_stack = set()
    stack = []
    sccs = []
    counter = [0]

    def strongconnect(node):
        index_of[node] = lowlink[node] = counter[0]
        counter[0] += 1
        stack.append(node)
        on_stack.add(node)
        for dep in pos_deps[node]:
            if dep not in index_of:
                strongconnect(dep)
                lowlink[node] = min(lowlink[node], lowlink[dep])
            elif dep in on_stack:
                lowlink[node] = min(lowlink[node], index_of[dep])
        if lowlink[node] == index_of[node]:
            scc = set()
            while True:
                member = stack.pop()
                on_stack.discard(member)
                scc.add(member)
                if member == node:
                    break
            sccs.append(scc)

    for pred in sorted(preds):
        if pred not in index_of:
            strongconnect(pred)

    scc_of = {}
    for i, scc in enumerate(sccs):
        for member in scc:
            scc_of[member] = i

    # Kahn topological order of the condensation (dependencies first).
    cond_deps = [set() for _ in sccs]
    for rule in rules:
        for atom in rule.neg:
            if scc_of[atom] == scc_of[rule.head]:
                raise ValueError(f"unstratified negation in rule {rule!r}")
        for atom in list(rule.pos) + list(rule.neg):
            src, dst = scc_of[atom], scc_of[rule.head]
            if src != dst:
                cond_deps[src].add(dst)
    indegree = [0] * len(sccs)
    for src in range(len(sccs)):
        for dst in cond_deps[src]:
            indegree[dst] += 1
    order = [i for i in range(len(sccs)) if indegree[i] == 0]
    pos = 0
    while pos < len(order):
        src = order[pos]
        pos += 1
        for dst in cond_deps[src]:
            indegree[dst] -= 1
            if indegree[dst] == 0:
                order.append(dst)

    # Saturate stratum by stratum; negative literals only ever reference
    # strata that are already final.
    facts = set(base)
    for scc_id in order:
        heads = sccs[scc_id]
        changed = True
        while changed:
            changed = False
            for rule in rules:
                if rule.head not in heads or rule.head in facts:
                    continue
                if all(a in facts for a in rule.pos) and all(
                    a not in facts for a in rule.neg
                ):
                    facts.add(rule.head)
                    changed = True
    return facts
