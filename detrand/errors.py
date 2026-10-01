"""Error types for detrand. Each error maps to a stable code and exit status."""


class DetrandError(Exception):
    code = "E_DETRAND"
    exit_code = 1


class SpecError(DetrandError):
    """The spec file is invalid."""

    code = "E_SPEC"
    exit_code = 2


class ReplayError(DetrandError):
    """The record file is missing, malformed, or incomplete."""

    code = "E_REPLAY"
    exit_code = 3


class DivergeError(DetrandError):
    """Replay diverged from the record, or an invariant was violated."""

    code = "E_DIVERGE"
    exit_code = 4
