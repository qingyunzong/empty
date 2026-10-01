"""Exception hierarchy for the delta update applier."""


class UpdateError(Exception):
    """Base class for all update failures."""


class DecodeError(UpdateError):
    """The update stream is malformed."""


class BadMagicError(DecodeError):
    """Stream does not start with the expected magic."""


class NonCanonicalVarintError(DecodeError):
    """A varint was not encoded in its minimal (canonical) form."""


class LengthOverflowError(DecodeError):
    """A varint/length field exceeds the bounded 63-bit range."""


class UnknownOpcodeError(DecodeError):
    """An instruction opcode byte is not defined."""


class TrailingDataError(DecodeError):
    """Bytes remain after the final hash of the stream."""


class BlockLengthExceededError(UpdateError):
    """An instruction would grow the output beyond the declared block length.

    Raised *before* any byte of the offending instruction is written, so an
    anomalous instruction never enlarges the output.
    """


class BlockLengthMismatchError(UpdateError):
    """END_BLOCK reached but produced length != declared block length."""


class CopyOutOfRangeError(UpdateError):
    """COPY_OUT references output bytes that have not been generated yet."""


class BaselineRangeError(UpdateError):
    """COPY_BASE references bytes outside the baseline file."""


class HashMismatchError(UpdateError):
    """A block hash or the final total hash does not match."""


class FingerprintMismatchError(UpdateError):
    """The baseline file does not match the fingerprint in the stream/checkpoint."""


class CheckpointError(UpdateError):
    """Checkpoint or temporary output file failed verification on resume."""


class Interrupted(UpdateError):
    """Raised by the interrupt hook to simulate a crash/interruption."""
