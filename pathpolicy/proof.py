"""Inclusion, equivalence and shortest-difference queries.

A <= B  is decided by emptiness of the product  DFA(A) x DFA(L \\ B),
where L is the legal path language: the complement of B is always taken
relative to legal normalized paths, never relative to arbitrary strings.

* If the product is empty, an independently verifiable inclusion proof is
  emitted (the full reachable product graph; a verifier recomputes the
  component automata and replays the certificate).
* Otherwise BFS yields the shortest difference witness(es); every witness
  is re-normalized and re-checked by both sides of the independent
  recursive interpreter before it is reported.
* State budget exhaustion yields ``unknown`` plus the resumable frontier.

Finite sampling is never used as evidence for inclusion or equivalence.
"""

from .chars import OTHER, SEPARATOR, witness_char
from .dfa import Budget, legal_dfa, product_multi, shortest_accept_paths
from .interpreter import interp_match_normalized
from .normalize import normalize_path
from .ruleset import (
    BudgetExhausted,
    alphabet_of,
    compile_expr,
    expr_to_json,
)

OTHER_JSON = "<OTHER>"


def _sym_json(sym):
    return OTHER_JSON if sym is OTHER else sym


def _alphabet_json(alphabet):
    return {
        "chars": [s for s in alphabet if s is not OTHER and s != SEPARATOR],
        "other": True,
        "separator": SEPARATOR,
    }


def _symbols_to_string(symbols, alphabet):
    mentioned = {s for s in alphabet if s is not OTHER and s != SEPARATOR}
    return "".join(
        witness_char(mentioned) if sym is OTHER else sym for sym in symbols
    )


def verify_witness(witness, a, b):
    """Re-check a difference witness: it must survive actual normalization
    unchanged and both sides of the independent interpreter must agree."""
    try:
        if normalize_path(witness) != witness:
            return False
    except ValueError:
        return False
    return interp_match_normalized(a, witness) and not interp_match_normalized(
        b, witness
    )


def find_difference(a, b, budget=10000, all_shortest=False):
    """Search for the shortest legal path in ``A \\ B``.

    Returns a dict with status ``empty`` (plus an inclusion proof),
    ``nonempty`` (plus interpreter-verified witnesses) or ``unknown``
    (plus the resumable frontier).
    """
    alphabet = alphabet_of(a, b)
    states = Budget(budget)
    try:
        da = compile_expr(a, alphabet, states)
        db = compile_expr(b, alphabet, states)
    except BudgetExhausted as exc:
        return {
            "status": "unknown",
            "reason": "state budget exhausted while compiling rules",
            "frontier": exc.frontier,
        }
    nb = db.complemented()
    legal = legal_dfa(alphabet)
    result = product_multi([da, nb, legal], lambda flags: all(flags), states)
    if not result.done:
        return {
            "status": "unknown",
            "reason": "state budget exhausted during product construction",
            "frontier": result.frontier_json(),
        }
    paths = shortest_accept_paths(result.dfa, all_paths=all_shortest)
    if not paths:
        return {
            "status": "empty",
            "proof": _build_proof(a, b, alphabet, da, db, nb, legal, result),
        }
    witnesses = [_symbols_to_string(p, alphabet) for p in paths]
    if not all(verify_witness(w, a, b) for w in witnesses):
        raise AssertionError("automaton/interpreter disagreement on witness")
    return {"status": "nonempty", "witnesses": witnesses, "witness_verified": True}


def _build_proof(a, b, alphabet, da, db, nb, legal, product):
    states = []
    for state_id, parts in enumerate(product.parts):
        states.append(
            {
                "id": state_id,
                "a": parts[0],
                "not_b": parts[1],
                "legal": parts[2],
                "accepts": [
                    parts[0] in da.accepts,
                    parts[1] in nb.accepts,
                    parts[2] in legal.accepts,
                ],
            }
        )
    transitions = []
    for state_id in range(product.dfa.num_states):
        for sym in product.dfa.alphabet:
            transitions.append(
                {
                    "from": state_id,
                    "symbol": _sym_json(sym),
                    "to": product.dfa.trans[state_id][sym],
                }
            )
    return {
        "type": "inclusion-proof",
        "method": "dfa-product-emptiness",
        "statement": (
            "A \\ B contains no legal path: the product "
            "DFA(A) x DFA(L \\ B) has no reachable accepting state"
        ),
        "a": expr_to_json(a),
        "b": expr_to_json(b),
        "alphabet": _alphabet_json(alphabet),
        "legal_language": (
            "L = '' | seg ('/' seg)* with seg = [^/]+ "
            "(normalized relative paths)"
        ),
        "start": list(product.parts[0]),
        "states": states,
        "transitions": transitions,
        "bad_states": [],
    }


def check_inclusion(a, b, budget=10000):
    diff = find_difference(a, b, budget)
    if diff["status"] == "empty":
        return {"status": "included", "proof": diff["proof"]}
    if diff["status"] == "nonempty":
        return {
            "status": "not_included",
            "witness": diff["witnesses"][0],
            "witness_verified": diff["witness_verified"],
        }
    return diff


def check_equivalence(a, b, budget=10000):
    ab = check_inclusion(a, b, budget)
    ba = check_inclusion(b, a, budget)
    if ab["status"] == "included" and ba["status"] == "included":
        equivalent = True
    elif ab["status"] == "not_included" or ba["status"] == "not_included":
        equivalent = False
    else:
        equivalent = None
    return {"equivalent": equivalent, "a_subset_b": ab, "b_subset_a": ba}


def verify_inclusion_proof(a, b, proof, budget=10000):
    """Independently verify an inclusion proof for ``A <= B``.

    The verifier recomputes the component automata and the product from
    the rule expressions, replays every certificate state and transition
    against its own construction, and confirms that no reachable state is
    accepting in A, in L \\ B and in L simultaneously.
    """
    details = []

    def fail(message):
        details.append(message)
        return {"valid": False, "details": details}

    if not isinstance(proof, dict) or proof.get("type") != "inclusion-proof":
        return fail("not an inclusion proof")
    if proof.get("a") is not None and proof["a"] != expr_to_json(a):
        return fail("proof was issued for a different A")
    if proof.get("b") is not None and proof["b"] != expr_to_json(b):
        return fail("proof was issued for a different B")
    alphabet = alphabet_of(a, b)
    if proof.get("alphabet") != _alphabet_json(alphabet):
        return fail("alphabet mismatch")
    states_budget = Budget(budget)
    try:
        da = compile_expr(a, alphabet, states_budget)
        db = compile_expr(b, alphabet, states_budget)
    except BudgetExhausted:
        return {"valid": None, "details": ["verifier budget exhausted while compiling"]}
    nb = db.complemented()
    legal = legal_dfa(alphabet)
    result = product_multi([da, nb, legal], lambda flags: all(flags), states_budget)
    if not result.done:
        return {
            "valid": None,
            "details": ["verifier budget exhausted during product construction"],
        }
    components = (da, nb, legal)

    id_to_parts = {}
    for entry in proof.get("states", []):
        parts = (entry.get("a"), entry.get("not_b"), entry.get("legal"))
        accepts = [parts[k] in components[k].accepts for k in range(3)]
        if entry.get("accepts") != accepts:
            return fail("state %r has wrong accept flags" % (entry.get("id"),))
        if all(accepts):
            return fail("certificate contains a bad state")
        if parts not in result.ids:
            return fail(
                "state %r is not reachable in the recomputed product" % (parts,)
            )
        if entry.get("id") in id_to_parts:
            return fail("duplicate state id %r" % (entry.get("id"),))
        id_to_parts[entry["id"]] = parts
    if tuple(proof.get("start", [])) != result.parts[0]:
        return fail("start state mismatch")
    if set(id_to_parts.values()) != set(result.parts):
        return fail("certificate does not cover exactly the reachable states")

    transitions = {}
    for tr in proof.get("transitions", []):
        key = (tr.get("from"), tr.get("symbol"))
        if key in transitions:
            return fail("non-deterministic certificate")
        transitions[key] = tr.get("to")
    for state_id, parts in id_to_parts.items():
        for sym in alphabet:
            key = (state_id, _sym_json(sym))
            if key not in transitions:
                return fail(
                    "missing transition from state %r on %r"
                    % (state_id, _sym_json(sym))
                )
            target = transitions[key]
            if target not in id_to_parts:
                return fail("transition to unknown state %r" % (target,))
            expected = tuple(components[k].trans[parts[k]][sym] for k in range(3))
            if id_to_parts[target] != expected:
                return fail(
                    "wrong transition from state %r on %r"
                    % (state_id, _sym_json(sym))
                )
    # Ground truth is the verifier's own recomputation.
    if result.dfa.accepts:
        return fail("recomputed product contains a reachable bad state")
    details.append(
        "certificate consistent with independent recomputation; "
        "no reachable state accepts in A, L \\ B and L simultaneously"
    )
    return {"valid": True, "details": details}
