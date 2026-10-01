"""upval: a tiny language with lexical closures and upvalue capture.

Pipeline: parse -> resolve (scope + escape analysis) -> interpret.
Two interpreters are provided:

* ``interp``    -- compiled-style: boxed locals live in shared heap
                   cells, unboxed locals in frame slots;
* ``refinterp`` -- reference: explicit chained environments, used as
                   the semantic ground truth for differential tests.
"""

from .errors import (  # noqa: F401
    ArityError,
    CompileError,
    DivZero,
    DuplicateDef,
    FreeVar,
    NotCallable,
    ParseError,
    RuntimeFailure,
    TypeMismatch,
    UninitializedVar,
    UpvalError,
)
from .interp import run as run_compiled
from .parser import parse
from .refinterp import run as run_reference
from .resolver import Resolver, debug_dict


def compile_source(src):
    """Parse and resolve ``src``; returns the top-level FnInfo."""
    block = parse(src)
    resolver = Resolver()
    return resolver.resolve(block)


def run_source(src, reference=False):
    top = compile_source(src)
    return (run_reference if reference else run_compiled)(top)


__all__ = [
    "compile_source",
    "run_source",
    "run_compiled",
    "run_reference",
    "debug_dict",
    "parse",
]
