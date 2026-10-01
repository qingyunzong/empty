"""JSON command line interface for the lazy DFA library.

Subcommands:
  build   NFA.json -> machine checkpoint JSON (optionally budgeted)
  expand  machine.json -> machine checkpoint JSON with more states expanded
  query   machine.json + symbol string -> accept / reject / unknown
  check   NFA.json -> cross-check DFA against the reference interpreter

A machine checkpoint file is a complete snapshot: discovered subsets,
pending frontier and canonical numbering.  `expand` therefore doubles
as checkpoint-resume; restoring any number of times yields the same
final machine as one uninterrupted run.
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys

from .dfa import ACCEPT, LazyDFA
from .interp import accepts as interp_accepts
from .nfa import NFA


def _load_json(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _dump(data) -> None:
    json.dump(data, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def _parse_symbols(text: str) -> list[int]:
    """Accept a JSON array of ints or a plain string (one char = one int)."""
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        value = None
    if isinstance(value, list) and all(isinstance(v, int) for v in value):
        return list(value)
    return [ord(c) for c in text]


def _default_alphabet(nfa: NFA) -> list[int]:
    points = set()
    for e in nfa.edges.values():
        if not e.is_epsilon:
            points.add(e.lo)
            points.add(e.hi)
    return sorted(points)


def cmd_build(args) -> int:
    nfa = NFA.from_dict(_load_json(args.nfa_json))
    dfa = LazyDFA(nfa, state_budget=args.state_budget,
                  transition_budget=args.transition_budget)
    if not args.no_expand:
        dfa.expand_all()
    _dump(dfa.to_dict())
    return 0


def cmd_expand(args) -> int:
    dfa = LazyDFA.from_dict(_load_json(args.machine_json))
    dfa.expand(args.steps)
    _dump(dfa.to_dict())
    return 0


def cmd_query(args) -> int:
    dfa = LazyDFA.from_dict(_load_json(args.machine_json))
    result = dfa.query(_parse_symbols(args.symbols))
    _dump({"result": result})
    return 0 if result == ACCEPT else 1


def cmd_check(args) -> int:
    nfa = NFA.from_dict(_load_json(args.nfa_json))
    alphabet = (_parse_symbols(args.alphabet) if args.alphabet
                else _default_alphabet(nfa))
    dfa = LazyDFA(nfa)
    dfa.expand_all()
    mismatches = []
    checked = 0
    for length in range(args.max_len + 1):
        for tup in itertools.product(alphabet, repeat=length):
            got = dfa.query(tup)
            want = ACCEPT if interp_accepts(nfa, tup) else "reject"
            checked += 1
            if got != want:
                mismatches.append({"string": list(tup), "dfa": got,
                                   "interpreter": want})
    _dump({"checked": checked, "mismatches": mismatches})
    return 0 if not mismatches else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="lazydfa", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("build", help="build a machine checkpoint from an NFA")
    p.add_argument("nfa_json")
    p.add_argument("--state-budget", type=int, default=None)
    p.add_argument("--transition-budget", type=int, default=None)
    p.add_argument("--no-expand", action="store_true",
                   help="leave every state unexpanded")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("expand", help="expand pending states of a checkpoint")
    p.add_argument("machine_json")
    p.add_argument("--steps", type=int, default=None,
                   help="expand at most this many states")
    p.set_defaults(func=cmd_expand)

    p = sub.add_parser("query", help="run a symbol string on the machine")
    p.add_argument("machine_json")
    p.add_argument("symbols",
                   help="JSON int array, or a plain string (ord per char)")
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("check",
                       help="cross-check the DFA against the interpreter")
    p.add_argument("nfa_json")
    p.add_argument("--max-len", type=int, default=4)
    p.add_argument("--alphabet", default=None,
                   help="JSON int array; defaults to edge endpoints")
    p.set_defaults(func=cmd_check)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
