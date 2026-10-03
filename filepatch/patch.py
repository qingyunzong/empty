"""High-level patch building, verification, application and inversion."""
from __future__ import annotations

from .apply import ApplyError, apply_ops
from .matching import solve, verify_certificate
from .model import Tree, content_sha256
from .planner import invert_ops, plan_ops

PATCH_FORMAT = "filepatch-1"


def build_patch(source, target):
    """Compute the minimum-cost executable patch from ``source`` to ``target``.

    Both arguments are :class:`~filepatch.model.Tree` instances.  The
    returned dict is JSON-serializable and contains the cost, the ordered
    operations and the dual-potential optimality certificate.
    """
    result = solve(source.files, target.files)
    ops = plan_ops(source.files, target.files, result.assignments)
    return {
        "format": PATCH_FORMAT,
        "cost": result.cost,
        "source_fingerprint": source.fingerprint(),
        "target_fingerprint": target.fingerprint(),
        "ops": ops,
        "certificate": result.certificate(),
    }


def verify_patch(source, target, patch):
    """Verify a patch's optimality certificate (no optimizer is run)."""
    if patch.get("format") != PATCH_FORMAT:
        raise ApplyError("unknown patch format")
    if patch.get("source_fingerprint") != source.fingerprint():
        raise ApplyError("patch source fingerprint does not match the source tree")
    if patch.get("target_fingerprint") != target.fingerprint():
        raise ApplyError("patch target fingerprint does not match the target tree")
    verify_certificate(source.files, target.files, patch["certificate"])
    if patch.get("cost") != patch["certificate"]["cost"]:
        raise ApplyError("patch cost disagrees with its certificate")
    return True


def apply_patch(tree, patch, check_target=True):
    """Apply ``patch`` to ``tree``; return the resulting new :class:`Tree`.

    All source fingerprints (whole-tree and per-operation) are validated
    before anything is committed; on any failure the input tree is left
    completely unchanged and :class:`ApplyError` is raised.
    """
    if patch.get("format") != PATCH_FORMAT:
        raise ApplyError("unknown patch format")
    expected = patch.get("source_fingerprint")
    if expected is not None and expected != tree.fingerprint():
        raise ApplyError("source tree fingerprint mismatch; patch not applied")
    # Apply on a copy: any validation failure leaves ``tree`` untouched.
    new_files = apply_ops(tree.files, patch.get("ops", []))
    result = Tree(new_files)
    if check_target:
        target_fp = patch.get("target_fingerprint")
        if target_fp is not None and result.fingerprint() != target_fp:
            raise ApplyError("patch did not produce the expected target tree")
    return result


def invert_patch(patch):
    """Produce the reverse patch (target -> source)."""
    if patch.get("format") != PATCH_FORMAT:
        raise ApplyError("unknown patch format")
    return {
        "format": PATCH_FORMAT,
        "cost": patch.get("cost"),
        "source_fingerprint": patch.get("target_fingerprint"),
        "target_fingerprint": patch.get("source_fingerprint"),
        "ops": invert_ops(patch.get("ops", [])),
        "certificate": None,
    }
