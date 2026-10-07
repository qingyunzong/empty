"""Exception hierarchy for the delta update library."""


class DeltaError(Exception):
    """Base class for all delta update failures."""


class FormatError(DeltaError):
    """Structurally invalid stream (bad magic, unknown opcode, overrun)."""


class LengthOverflowError(DeltaError):
    """A length varint or declared length exceeds its allowed bound."""


class CopyFromUngeneratedError(DeltaError):
    """A copy references bytes that have not been generated."""


class CopyBaseOutOfRangeError(CopyFromUngeneratedError):
    """COPY_BASE references bytes beyond the end of the baseline file."""


class CopyOutUngeneratedError(CopyFromUngeneratedError):
    """COPY_OUT references output bytes not yet produced."""


class ChecksumMismatchError(DeltaError):
    """A block hash or the final total hash does not match."""


class LengthMismatchError(DeltaError):
    """Produced output length disagrees with a declared length."""


class BaselineMismatchError(DeltaError):
    """Baseline file does not match the fingerprint in the stream."""


class UnexpectedEndError(DeltaError):
    """The stream ended before the final trailer was decoded."""


class ResumeError(DeltaError):
    """A checkpoint or temporary output failed resume verification."""


class TempOutputMismatchError(ResumeError):
    """Temporary output prefix does not match the checkpoint state."""
