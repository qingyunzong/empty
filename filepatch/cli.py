"""JSON command line interface.

Subcommands:

* ``diff A.json B.json``    -> patch JSON (operations + certificate)
* ``apply TREE.json P.json``-> patched tree JSON
* ``invert P.json``         -> reverse patch JSON
* ``verify A.json B.json P.json`` -> check the optimality certificate

Tree JSON format: ``{"files": [{"path": ..., "type": "file",
"lines": [...]}, ...]}``.
"""
from __future__ import annotations

import argparse
import json
import sys

from .apply import ApplyError
from .matching import CertificateError
from .model import Tree, TreeError
from .patch import apply_patch, build_patch, invert_patch, verify_patch


def _read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _emit(obj, out):
    text = json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if out:
        with open(out, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)


def _load_tree(path):
    return Tree.from_descriptor(_read_json(path))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="filepatch")
    sub = parser.add_subparsers(dest="command", required=True)

    p_diff = sub.add_parser("diff", help="compute a minimum-cost patch")
    p_diff.add_argument("source")
    p_diff.add_argument("target")
    p_diff.add_argument("--out")

    p_apply = sub.add_parser("apply", help="apply a patch to a tree")
    p_apply.add_argument("tree")
    p_apply.add_argument("patch")
    p_apply.add_argument("--out")

    p_invert = sub.add_parser("invert", help="invert a patch")
    p_invert.add_argument("patch")
    p_invert.add_argument("--out")

    p_verify = sub.add_parser("verify", help="verify a patch certificate")
    p_verify.add_argument("source")
    p_verify.add_argument("target")
    p_verify.add_argument("patch")

    args = parser.parse_args(argv)
    try:
        if args.command == "diff":
            source = _load_tree(args.source)
            target = _load_tree(args.target)
            _emit(build_patch(source, target), args.out)
        elif args.command == "apply":
            tree = _load_tree(args.tree)
            patch = _read_json(args.patch)
            _emit(apply_patch(tree, patch).to_descriptor(), args.out)
        elif args.command == "invert":
            _emit(invert_patch(_read_json(args.patch)), args.out)
        elif args.command == "verify":
            source = _load_tree(args.source)
            target = _load_tree(args.target)
            patch = _read_json(args.patch)
            verify_patch(source, target, patch)
            _emit({"ok": True, "cost": patch["certificate"]["cost"]}, None)
        return 0
    except (TreeError, ApplyError, CertificateError, KeyError, OSError) as exc:
        json.dump({"ok": False, "error": str(exc)}, sys.stdout)
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
