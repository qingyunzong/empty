"""Resumable, checkpointed, atomic delta-update applier.

Public surface:
    Applier            -- windowed, resumable applier (64 KiB memory window)
    interpret          -- independent in-memory oracle (short outputs)
    build_update       -- construct update streams from instruction tuples
    encode_stream      -- offline baseline+target -> update stream encoder
    Decoder            -- incremental stream decoder (arbitrary byte slices)
    Sha256             -- pure-Python SHA-256 with serializable state
"""

from .applier import Applier
from .builder import build_update
from .decoder import Decoder
from .encoder import encode_stream
from .errors import (BaselineRangeError, BlockLengthExceededError,
                     BlockLengthMismatchError, CheckpointError, CopyOutOfRangeError,
                     DecodeError, FingerprintMismatchError, HashMismatchError,
                     Interrupted, LengthOverflowError, NonCanonicalVarintError,
                     TrailingDataError, UnknownOpcodeError, UpdateError)
from .interpreter import interpret
from .sha256 import Sha256

__all__ = [
    "Applier", "Decoder", "Sha256", "interpret", "build_update",
    "encode_stream", "UpdateError", "DecodeError", "LengthOverflowError",
    "NonCanonicalVarintError", "TrailingDataError", "UnknownOpcodeError",
    "BlockLengthExceededError", "BlockLengthMismatchError",
    "CopyOutOfRangeError", "BaselineRangeError", "HashMismatchError",
    "FingerprintMismatchError", "CheckpointError", "Interrupted",
]
