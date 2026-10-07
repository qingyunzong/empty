"""Resumable, checkpointed delta update library.

Public surface:

* :mod:`deltaup.decoder` -- incremental stream decoder.
* :mod:`deltaup.applier` -- windowed apply engine with checkpoints.
* :mod:`deltaup.encoder` -- stream construction helpers.
* :mod:`deltaup.reference` -- independent in-memory interpreter.
* :mod:`deltaup.errors` -- exception hierarchy.
"""

from .applier import Applier, apply_delta, resume_delta
from .decoder import Decoder
from .encoder import encode_delta, encode_delta_bytes, encode_instructions
from .reference import interpret

__all__ = [
    "Applier",
    "Decoder",
    "apply_delta",
    "resume_delta",
    "encode_delta",
    "encode_delta_bytes",
    "encode_instructions",
    "interpret",
]
