"""JSON command line interface for the symbolic DFA minimizer.

Usage:
    python3.11 -m symdfa minimize DFA.json [-o OUT.json]
    python3.11 -m symdfa update   DFA.json UPDATES.json [-o OUT.json]
    python3.11 -m symdfa verify   DFA.json CERT.json
    python3.11 -m symdfa baseline DFA.json
"""
from __future__ import annotations

import argparse
import json
import sys

from . import baseline
from .dfa import DFAError
from .incremental import IncrementalMinimizer, ValidationError
from .minimize import minimize
from .serialize import dfa_from_json, updates_from_json
from .verify import VerificationError, verify_certificate


def _load(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _emit(obj, out_path):
    text = json.dumps(obj, indent=2, sort_keys=True)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    else:
        print(text)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="symdfa", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_min = sub.add_parser("minimize", help="minimize a DFA and emit a certificate")
    p_min.add_argument("dfa")
    p_min.add_argument("-o", "--out")

    p_upd = sub.add_parser("update", help="apply an incremental update batch")
    p_upd.add_argument("dfa")
    p_upd.add_argument("updates")
    p_upd.add_argument("-o", "--out")

    p_ver = sub.add_parser("verify", help="verify a minimization certificate")
    p_ver.add_argument("dfa")
    p_ver.add_argument("cert")

    p_base = sub.add_parser(
        "baseline", help="cross-check minimizer against pairwise fixpoint"
    )
    p_base.add_argument("dfa")

    args = parser.parse_args(argv)
    try:
        if args.command == "minimize":
            result = minimize(dfa_from_json(_load(args.dfa)))
            _emit(result.to_dict(), args.out)
        elif args.command == "update":
            minimizer = IncrementalMinimizer(dfa_from_json(_load(args.dfa)))
            final_changes, transition_changes = updates_from_json(
                _load(args.updates)
            )
            result = minimizer.apply_updates(final_changes, transition_changes)
            _emit(result.to_dict(), args.out)
        elif args.command == "verify":
            dfa = dfa_from_json(_load(args.dfa))
            verify_certificate(dfa, _load(args.cert))
            _emit({"valid": True}, None)
        elif args.command == "baseline":
            dfa = dfa_from_json(_load(args.dfa))
            result = minimize(dfa)
            classes = baseline.pairwise_equivalence_classes(dfa)
            match = {frozenset(c) for c in classes} == {
                frozenset(b) for b in result.blocks
            }
            _emit(
                {
                    "match": match,
                    "minimizer_blocks": result.blocks,
                    "pairwise_classes": classes,
                },
                None,
            )
            return 0 if match else 1
    except DFAError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ValidationError as exc:
        print(f"validation failed (rolled back): {exc}", file=sys.stderr)
        return 3
    except VerificationError as exc:
        print(f"certificate invalid: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
