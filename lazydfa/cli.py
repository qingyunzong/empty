"""JSON command-line interface.

Reads a JSON spec from a file argument or stdin:

{
  "nfa": {"states": 3, "start": 0, "accepting": [2],
          "edges": [{"from": 0, "to": 1, "lo": 97, "hi": 122},
                    {"from": 1, "to": 2, "epsilon": true}]},
  "state_budget": 100,            // optional
  "transition_budget": 1000,      // optional
  "strings": ["ab", [97, 98]],    // optional; str -> code points
  "checkpoint_in": "path.json",   // optional
  "checkpoint_out": "path.json"   // optional
}

Writes the materialised machine (states, transitions with NFA-edge
witnesses, budget usage) plus per-string match results as JSON.
"""

from __future__ import annotations

import json
import sys

from .dfa import LazyDFA
from .nfa import NFA


def _string_to_symbols(s):
    if isinstance(s, str):
        return [ord(c) for c in s]
    return [int(c) for c in s]


def run(spec: dict) -> dict:
    nfa = NFA.from_json(spec["nfa"])
    state_budget = spec.get("state_budget")
    transition_budget = spec.get("transition_budget")
    if "checkpoint_in" in spec:
        with open(spec["checkpoint_in"]) as fh:
            data = json.load(fh)
        dfa = LazyDFA.restore(nfa, data, state_budget, transition_budget)
    else:
        dfa = LazyDFA(nfa, state_budget, transition_budget)
    dfa.expand()
    out = dfa.to_json()
    results = {}
    for s in spec.get("strings", []):
        symbols = _string_to_symbols(s)
        key = s if isinstance(s, str) else " ".join(map(str, symbols))
        results[key] = dfa.match(symbols)
    out["results"] = results
    if "checkpoint_out" in spec:
        with open(spec["checkpoint_out"], "w") as fh:
            json.dump(dfa.save_checkpoint(), fh, indent=2)
    return out


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) > 1:
        print("usage: python3.11 -m lazydfa [spec.json]", file=sys.stderr)
        raise SystemExit(2)
    if argv:
        with open(argv[0]) as fh:
            spec = json.load(fh)
    else:
        spec = json.load(sys.stdin)
    json.dump(run(spec), sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
