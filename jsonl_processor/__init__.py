"""JSONL processor: atomic per-id outputs, checkpointing, crash/recovery."""
from .core import (
    CRASH_AFTER_CHECKPOINT,
    CRASH_AFTER_READ,
    CRASH_AFTER_WRITE,
    CRASH_POINTS,
    MAX_ATTEMPTS,
    ProcessorError,
    RecordResult,
    SimulatedCrash,
    Workdir,
    run,
)

__all__ = [
    "CRASH_AFTER_CHECKPOINT",
    "CRASH_AFTER_READ",
    "CRASH_AFTER_WRITE",
    "CRASH_POINTS",
    "MAX_ATTEMPTS",
    "ProcessorError",
    "RecordResult",
    "SimulatedCrash",
    "Workdir",
    "run",
]
