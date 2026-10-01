"""Minimal-cost binary delta/patch tool."""

from .core import (
    COPY_COST,
    LIT_COST_PER_BYTE,
    PatchError,
    apply_patch,
    compute_ops,
    dumps_patch,
    sha256_hex,
)

__all__ = [
    "COPY_COST",
    "LIT_COST_PER_BYTE",
    "PatchError",
    "apply_patch",
    "compute_ops",
    "dumps_patch",
    "sha256_hex",
]
