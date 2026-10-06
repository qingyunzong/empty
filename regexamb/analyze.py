"""Top-level ambiguity analysis.

Decision procedure (for the unambiguity certificate):

1. every node has at most one parse of the empty word (this also excludes
   stars wrapping a nullable child, which have infinitely many), and
2. the branch-labelled position automaton is unambiguous, checked by
   exploring the synchronised pair product for a divergent pair of
   accepting states.

If the expression is ambiguous, bounded enumeration by increasing word
length produces the shortest (then lexicographically smallest) witness
word together with two real parse trees; pumpable epsilon cycles are
reported when the witness word has infinitely many parses.  If the work
budget runs out first, the result is ``unknown`` plus a checkpoint that
a later call can resume from.
"""
from __future__ import annotations

from .syntax import LIT, collect_nodes
from .parsetree import tree_to_json, tree_from_json, verify_parse
from .properties import epsilon_parse_count
from .automaton import nfa_ambiguity
from .enumerate import Enumerator, BudgetExhausted
from .witnesses import epsilon_loop_evidence


def analyze(root, alphabet=None, budget: int = 200000, resume_state: dict | None = None) -> dict:
    nodes = collect_nodes(root)
    if alphabet is None:
        alphabet = sorted({n.char for n in nodes.values() if n.kind == LIT})
    else:
        alphabet = list(alphabet)
    order = {c: i for i, c in enumerate(alphabet)}

    # --- decision procedure -------------------------------------------
    eps_bad = None
    max_eps = 0
    for nid, node in nodes.items():
        count = epsilon_parse_count(node)
        max_eps = max(max_eps, count)
        if count >= 2 and eps_bad is None:
            eps_bad = nid
    nfa_amb, nfa_stats = nfa_ambiguity(root)

    if eps_bad is None and not nfa_amb:
        return {
            "status": "unambiguous",
            "alphabet": alphabet,
            "certificate": {
                "type": "unambiguous",
                "max_epsilon_parses_per_node": max_eps,
                "glushkov": {
                    "positions": nfa_stats["positions"],
                    "pair_states_explored": nfa_stats["pair_states"],
                    "divergent_accepting_pair": False,
                },
                "note": (
                    "every node has at most one empty-word parse and the "
                    "synchronised pair product of the position automaton "
                    "contains no divergent pair of accepting states"
                ),
            },
        }

    # --- witness search ------------------------------------------------
    enum = Enumerator(root, budget=budget, state=resume_state)
    try:
        n = enum.n_done + 1
        while True:
            levels = enum.compute_level(n)
            level = levels[root.id][n]
            ambiguous_words = [w for w, ts in level.items() if len(ts) >= 2]
            if ambiguous_words:
                word = min(ambiguous_words,
                           key=lambda w: tuple(order.get(c, len(order)) for c in w))
                t1, t2 = level[word][0], level[word][1]
                verify_parse(t1, nodes, word)
                verify_parse(t2, nodes, word)
                result = {
                    "status": "ambiguous",
                    "word": word,
                    "parses": [tree_to_json(t1), tree_to_json(t2)],
                    "stats": {"work": enum.work, "witness_length": n},
                }
                loop = epsilon_loop_evidence(root, nodes, word)
                if loop is not None:
                    verify_parse(tree_from_json(loop["base_parse"]), nodes, word)
                    verify_parse(tree_from_json(loop["pumped_parse"]), nodes, word)
                    result["infinite"] = True
                    result["epsilon_loop"] = loop
                else:
                    result["infinite"] = False
                return result
            n += 1
    except BudgetExhausted:
        return {
            "status": "unknown",
            "reason": "work budget exhausted",
            "checkpoint": enum.checkpoint(),
            "stats": {"work": enum.work, "lengths_completed": enum.n_done + 1},
        }
