"""JSON command-line interface.

Usage:
    python3.11 -m symdfa.cli minimize INPUT.json [-o OUT.json]
    python3.11 -m symdfa.cli apply INPUT.json CHANGES.json [-o OUT.json]
    python3.11 -m symdfa.cli verify INPUT.json CERT.json

``apply`` performs a batch incremental update; CHANGES.json may contain
``finals`` and/or ``transitions`` keys.  On failure the previous partition
is restored and the command exits non-zero.
"""

from __future__ import annotations

import argparse
import json
import sys

from .automaton import SymbolicDFA
from .certificate import verify_certificate
from .minimizer import Minimizer


def _load_dfa(path: str) -> SymbolicDFA:
    with open(path, "r", encoding="utf-8") as fh:
        return SymbolicDFA.from_dict(json.load(fh))


def _dump(data: dict, out: str | None) -> None:
    text = json.dumps(data, indent=2, sort_keys=True)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="symdfa")
    sub = parser.add_subparsers(dest="command", required=True)

    p_min = sub.add_parser("minimize", help="full rebuild minimization")
    p_min.add_argument("input")
    p_min.add_argument("-o", "--out")

    p_app = sub.add_parser("apply", help="incremental batch update")
    p_app.add_argument("input")
    p_app.add_argument("changes")
    p_app.add_argument("-o", "--out")

    p_ver = sub.add_parser("verify", help="verify a minimization certificate")
    p_ver.add_argument("input")
    p_ver.add_argument("certificate")

    args = parser.parse_args(argv)

    if args.command == "minimize":
        dfa = _load_dfa(args.input)
        _dump(Minimizer(dfa).result(), args.out)
        return 0

    if args.command == "apply":
        dfa = _load_dfa(args.input)
        with open(args.changes, "r", encoding="utf-8") as fh:
            changes = json.load(fh)
        minimizer = Minimizer(dfa)
        try:
            minimizer.apply_changes(
                finals=changes.get("finals"),
                transitions=[
                    [(edge["intervals"], edge["target"]) for edge in row]
                    for row in changes["transitions"]
                ] if "transitions" in changes else None,
            )
        except Exception as exc:  # rollback already happened
            print(f"apply failed, previous partition restored: {exc}",
                  file=sys.stderr)
            return 1
        _dump(minimizer.result(), args.out)
        return 0

    if args.command == "verify":
        dfa = _load_dfa(args.input)
        with open(args.certificate, "r", encoding="utf-8") as fh:
            cert = json.load(fh)
        errors = verify_certificate(dfa, cert)
        if errors:
            for err in errors:
                print(f"INVALID: {err}", file=sys.stderr)
            return 1
        print("certificate valid")
        return 0

    return 2  # pragma: no cover


if __name__ == "__main__":
    sys.exit(main())
