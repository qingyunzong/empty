"""JSON command-line interface.

    python3.11 -m patchtool diff   OLD.json NEW.json [-o patch.json]
    python3.11 -m patchtool apply  TREE.json PATCH.json [-o out.json]
    python3.11 -m patchtool verify OLD.json NEW.json PATCH.json

``diff`` emits the minimal patch (with optimality certificate), ``apply``
executes a patch atomically, and ``verify`` checks the certificate and the
patch end-to-end without running the optimiser.
"""
from __future__ import annotations

import argparse
import json
import sys

from .apply import ApplyError, apply_patch
from .certificate import CertificateError, verify_certificate
from .model import FileTree, ModelError
from .patch import diff_trees, op_key


def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _dump(obj, out):
    text = json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)


def _cmd_diff(args):
    old = FileTree.from_dict(_load_json(args.old))
    new = FileTree.from_dict(_load_json(args.new))
    _dump(diff_trees(old, new), args.out)
    return 0


def _cmd_apply(args):
    tree = FileTree.from_dict(_load_json(args.tree))
    patch = _load_json(args.patch)
    result = apply_patch(tree, patch)
    _dump(result.to_dict(), args.out)
    return 0


def _cmd_verify(args):
    old = FileTree.from_dict(_load_json(args.old))
    new = FileTree.from_dict(_load_json(args.new))
    patch = _load_json(args.patch)
    try:
        if not isinstance(patch, dict) or patch.get("version") != 1:
            raise CertificateError("unsupported patch")
        cert = patch.get("certificate")
        if not isinstance(cert, dict):
            raise CertificateError("missing certificate")
        if patch.get("cost") != cert.get("cost"):
            raise CertificateError("patch cost disagrees with certificate")
        ops = patch.get("ops")
        if not isinstance(ops, list):
            raise CertificateError("missing operations")
        op_tuples = [op_key(o) for o in ops]
        if op_tuples != sorted(op_tuples):
            raise CertificateError("operations are not in canonical order")
        if sum(o.get("cost", -1) for o in ops) != patch["cost"]:
            raise CertificateError("operation costs do not add up")
        if patch.get("src_fingerprints") != old.file_fingerprints():
            raise CertificateError("source fingerprints mismatch")
        if patch.get("dst_fingerprints") != new.file_fingerprints():
            raise CertificateError("destination fingerprints mismatch")
        verify_certificate(old, new, cert, expected_ops=op_tuples)
        if apply_patch(old, patch) != new:
            raise CertificateError("applying the patch does not yield the target")
    except (CertificateError, ApplyError, ModelError, KeyError, TypeError) as exc:
        _dump({"valid": False, "error": str(exc)}, args.out)
        return 1
    _dump({"valid": True}, args.out)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="patchtool",
                                     description="Minimal-cost file-tree patches")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("diff", help="compute a minimal patch OLD -> NEW")
    p.add_argument("old")
    p.add_argument("new")
    p.add_argument("-o", "--out")
    p.set_defaults(func=_cmd_diff)

    p = sub.add_parser("apply", help="apply a patch to a tree")
    p.add_argument("tree")
    p.add_argument("patch")
    p.add_argument("-o", "--out")
    p.set_defaults(func=_cmd_apply)

    p = sub.add_parser("verify", help="verify a patch certificate (no optimiser)")
    p.add_argument("old")
    p.add_argument("new")
    p.add_argument("patch")
    p.add_argument("-o", "--out")
    p.set_defaults(func=_cmd_verify)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ModelError, ApplyError, CertificateError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
