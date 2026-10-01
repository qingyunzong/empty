"""Error types and exit codes for detrand."""


class DetrandError(Exception):
    code = "E_DETRAND"
    exit_code = 1


class SpecError(DetrandError):
    code = "E_SPEC"
    exit_code = 2


class ReplayError(DetrandError):
    code = "E_REPLAY"
    exit_code = 3


class DivergeError(DetrandError):
    code = "E_DIVERGE"
    exit_code = 4


class InvariantError(DetrandError):
    code = "E_INVARIANT"
    exit_code = 5
