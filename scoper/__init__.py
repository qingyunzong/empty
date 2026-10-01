"""scoper: lexical scope resolution over a parsed AST JSON tree.

Semantics implemented:

* Globals (builtins) and function parameters are bound on scope entry.
* ``let`` / ``const`` bindings have a TDZ: they exist (and shadow outer
  bindings) from the start of their block but are unusable until their
  declaration statement is reached.
* ``fn`` declarations are resolvable from the start of their block, but
  their bodies are resolved lazily at the definition point, capturing the
  environment as it stands there.
* ``use`` resolves to the nearest visible binding; ``assign`` to a
  non-writable const raises :class:`AssignConstError`.
* Undefined names, duplicate definitions and TDZ accesses raise
  :class:`ScopeError`.
"""

from .errors import (
    AssignConstError,
    ScopeError,
    KIND_ASSIGN_CONST,
    KIND_DUPLICATE,
    KIND_TDZ,
    KIND_UNDEFINED,
)
from .resolver import BUILTINS, resolve_program

__all__ = [
    "AssignConstError",
    "BUILTINS",
    "ScopeError",
    "KIND_ASSIGN_CONST",
    "KIND_DUPLICATE",
    "KIND_TDZ",
    "KIND_UNDEFINED",
    "resolve_program",
]
