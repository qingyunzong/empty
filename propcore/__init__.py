"""propcore: a tiny property-based testing core with shrinking and caching."""

from .engine import (
    ERROR,
    KNOWN_FAIL,
    PASS,
    PROPERTY_FAIL,
    cache_key,
    check,
    run_property,
    run_spec,
    shrink,
)
from .generators import (
    SpecError,
    candidates,
    canonical,
    fits,
    gen_version,
    generate,
    normalize_gen,
    order_key,
    size_of,
)
from .spec import load_spec, load_spec_file

__all__ = [
    "ERROR",
    "KNOWN_FAIL",
    "PASS",
    "PROPERTY_FAIL",
    "SpecError",
    "cache_key",
    "candidates",
    "canonical",
    "check",
    "fits",
    "gen_version",
    "generate",
    "load_spec",
    "load_spec_file",
    "normalize_gen",
    "order_key",
    "run_property",
    "run_spec",
    "shrink",
    "size_of",
]
