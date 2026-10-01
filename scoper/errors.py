"""Error types for the scoper name-resolution library."""

KIND_UNDEFINED = "Undefined"
KIND_DUPLICATE = "Duplicate"
KIND_TDZ = "TDZ"
KIND_ASSIGN_CONST = "AssignConst"


class ScopeError(Exception):
    """Raised for any scope-resolution failure.

    Carries the machine-readable fields required by the spec:
    ``name``, ``kind``, ``use_span`` and ``def_span``.
    """

    def __init__(self, kind, name, use_span, def_span):
        self.kind = kind
        self.name = name
        self.use_span = use_span
        self.def_span = def_span
        super().__init__(self._format())

    def _format(self):
        return "%s: %s (use_span=%r, def_span=%r)" % (
            self.kind, self.name, self.use_span, self.def_span)

    def to_dict(self):
        return {
            "kind": self.kind,
            "name": self.name,
            "use_span": self.use_span,
            "def_span": self.def_span,
        }


class AssignConstError(ScopeError):
    """Assignment to a non-writable (const / builtin) binding."""

    def __init__(self, name, use_span, def_span):
        super().__init__(KIND_ASSIGN_CONST, name, use_span, def_span)
