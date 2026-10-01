"""Certificate verifier.

Deliberately independent of the minimizer: it only uses plain DFA
simulation from ``symdfa.dfa`` and never calls any minimization,
refinement, or incremental machinery.  A certificate is accepted only if

1. the blocks exactly partition the reachable states,
2. every block is finality-uniform and transition-stable (a bisimulation,
   which proves all states inside a block equivalent), and
3. for every pair of distinct blocks the proof DAG yields a concrete word
   that simulation shows is accepted from exactly one side (which proves
   states in different blocks inequivalent).
"""
from __future__ import annotations

from .dfa import reachable


class VerificationError(Exception):
    """Raised when a certificate fails verification."""


def _fail(message):
    raise VerificationError(message)


def _signature(dfa, state, block_of):
    rows = []
    for lo, hi, target in dfa.transitions[state]:
        block = block_of[target]
        if rows and rows[-1][2] == block and rows[-1][1] == lo - 1:
            rows[-1] = (rows[-1][0], hi, block)
        else:
            rows.append((lo, hi, block))
    return (state in dfa.finals, tuple(rows))


def verify_certificate(dfa, cert):
    """Verify a minimization certificate for ``dfa``; raise on failure."""
    try:
        raw_blocks = cert["blocks"]
        raw_mapping = cert["state_to_block"]
        automaton = cert["automaton"]
        dag = cert["proof_dag"]
    except (KeyError, TypeError) as exc:
        _fail(f"certificate is missing a section: {exc}")

    blocks = [sorted(int(s) for s in block) for block in raw_blocks]
    mapping = {}
    for key, value in raw_mapping.items():
        mapping[int(key)] = None if value is None else int(value)

    # 1. Blocks partition exactly the reachable states.
    reach = reachable(dfa)
    seen = set()
    for index, members in enumerate(blocks):
        if not members:
            _fail(f"block {index} is empty")
        for state in members:
            if state in seen:
                _fail(f"state {state} appears in two blocks")
            if state not in dfa.states:
                _fail(f"state {state} is not a DFA state")
            if mapping.get(state) != index:
                _fail(f"state_to_block disagrees with blocks for state {state}")
            seen.add(state)
    if seen != reach:
        _fail("blocks do not cover exactly the reachable states")
    for state in dfa.states:
        expected = mapping.get(state)
        if state in reach:
            if expected is None:
                _fail(f"reachable state {state} has no block")
        elif expected is not None:
            _fail(f"unreachable state {state} must map to null")

    # 2. Finality uniformity + transition stability inside each block.
    for index, members in enumerate(blocks):
        reference = _signature(dfa, members[0], mapping)
        for state in members[1:]:
            if _signature(dfa, state, mapping) != reference:
                _fail(f"block {index} is not transition-stable")

    # 3. The claimed quotient automaton matches the blocks.
    if int(automaton.get("alphabet_size", -1)) != dfa.alphabet_size:
        _fail("automaton alphabet size mismatch")
    if int(automaton.get("start", -1)) != mapping[dfa.start]:
        _fail("automaton start state mismatch")
    if sorted(int(s) for s in automaton.get("finals", [])) != [
        i for i, members in enumerate(blocks) if members[0] in dfa.finals
    ]:
        _fail("automaton finals mismatch")
    transitions = automaton.get("transitions", {})
    for index, members in enumerate(blocks):
        rows = transitions.get(str(index))
        if rows is None:
            _fail(f"automaton is missing transitions for block {index}")
        expected = _signature(dfa, members[0], mapping)[1]
        if [list(row) for row in expected] != [list(r) for r in rows]:
            _fail(f"automaton transitions mismatch for block {index}")

    # 4. Proof DAG: every block pair gets a valid distinguishing word.
    nodes = {}
    for node in dag.get("nodes", []):
        nodes[int(node["id"])] = node
    roots = dag.get("roots", {})
    for i in range(len(blocks)):
        for j in range(i + 1, len(blocks)):
            key = f"{i},{j}"
            if key not in roots:
                _fail(f"no proof for block pair ({i}, {j})")
            _check_proof_path(dfa, blocks, mapping, nodes, roots[key], (i, j))
    return True


def _check_proof_path(dfa, blocks, mapping, nodes, root_id, root_pair):
    node = nodes.get(root_id)
    if node is None:
        _fail(f"proof for pair {root_pair} references a missing node")
    if [int(x) for x in node["pair"]] != [root_pair[0], root_pair[1]]:
        _fail(f"proof root pair mismatch for {root_pair}")
    pair = root_pair
    word = []
    for _ in range(len(nodes) + 1):
        char = node["char"]
        if char is None:
            rep_a = blocks[pair[0]][0]
            rep_b = blocks[pair[1]][0]
            if (rep_a in dfa.finals) == (rep_b in dfa.finals):
                _fail(f"proof leaf for {root_pair} has no finality difference")
            root_a = blocks[root_pair[0]][0]
            root_b = blocks[root_pair[1]][0]
            accept_a = dfa.accepts(word, root_a)
            accept_b = dfa.accepts(word, root_b)
            if accept_a == accept_b:
                _fail(f"proof word {word} does not distinguish pair {root_pair}")
            return
        char = int(char)
        word.append(char)
        rep_a = blocks[pair[0]][0]
        rep_b = blocks[pair[1]][0]
        next_a = mapping[dfa.step(rep_a, char)]
        next_b = mapping[dfa.step(rep_b, char)]
        if next_a == next_b:
            _fail(f"proof step for {root_pair} stays inside one block")
        child = nodes.get(int(node["child"]))
        if child is None:
            _fail(f"proof for {root_pair} references a missing child node")
        expected = sorted((next_a, next_b))
        if [int(x) for x in child["pair"]] != expected:
            _fail(f"proof child pair mismatch for {root_pair}")
        pair = (expected[0], expected[1])
        node = child
    _fail(f"proof for pair {root_pair} is cyclic")
