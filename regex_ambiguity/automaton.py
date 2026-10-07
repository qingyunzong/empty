"""Branch-labelled epsilon-NFA built from a regex AST.

The construction is a Thompson-style fragment build where every transition
carries a sequence of *parse actions*.  The action sequence of a path is in
bijection with the parse tree the path derives, so two accepting paths of the
same word yield the same parse iff their action sequences are identical.
This is what prevents mistaking a mere difference in character/state paths
for a different parse.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

from .astnodes import Node, Lit, Eps, Union, Cat, Star

Action = Tuple  # ("enter",id) ("exit",id) ("choice",id,i) ("iter",id) ("lit",id) ("eps",id)


@dataclass
class Nfa:
    start: int
    final: int
    n_states: int
    char_trans: Dict[int, List[Tuple[str, Tuple[Action, ...], int]]]
    eps_trans: Dict[int, List[Tuple[Tuple[Action, ...], int]]]


def build_nfa(root: Node) -> Nfa:
    char_trans: Dict[int, list] = {}
    eps_trans: Dict[int, list] = {}
    counter = 0

    def new_state() -> int:
        nonlocal counter
        s = counter
        counter += 1
        return s

    def add_eps(src: int, actions, dst: int) -> None:
        eps_trans.setdefault(src, []).append((tuple(actions), dst))

    def add_char(src: int, char: str, actions, dst: int) -> None:
        char_trans.setdefault(src, []).append((char, tuple(actions), dst))

    def frag(node: Node) -> Tuple[int, int]:
        s, e = new_state(), new_state()
        nid = node.id
        if isinstance(node, Lit):
            add_char(s, node.char, (("enter", nid), ("lit", nid), ("exit", nid)), e)
        elif isinstance(node, Eps):
            add_eps(s, (("enter", nid), ("eps", nid), ("exit", nid)), e)
        elif isinstance(node, Union):
            for i, child in enumerate(node.children):
                cs, ce = frag(child)
                add_eps(s, (("enter", nid), ("choice", nid, i)), cs)
                add_eps(ce, (("exit", nid),), e)
        elif isinstance(node, Cat):
            if not node.children:
                add_eps(s, (("enter", nid), ("exit", nid)), e)
            else:
                frags = [frag(c) for c in node.children]
                add_eps(s, (("enter", nid),), frags[0][0])
                for (_, pe), (ns, _) in zip(frags, frags[1:]):
                    add_eps(pe, (), ns)
                add_eps(frags[-1][1], (("exit", nid),), e)
        elif isinstance(node, Star):
            cs, ce = frag(node.child)
            add_eps(s, (("enter", nid), ("exit", nid)), e)   # zero iterations
            add_eps(s, (("enter", nid), ("iter", nid)), cs)  # first iteration
            add_eps(ce, (("iter", nid),), cs)                # further iterations
            add_eps(ce, (("exit", nid),), e)                 # done
        else:
            raise TypeError(f"unknown node {node!r}")
        return s, e

    start, final = frag(root)
    return Nfa(start, final, counter, char_trans, eps_trans)
