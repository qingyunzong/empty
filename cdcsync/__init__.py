"""cdcsync: apply JSONL CDC logs to a SQLite KV store, exactly once."""
from .core import (GENESIS, CorruptLog, Engine, FaultInject, canonical,
                   payload_of, record_hash)

__version__ = "0.1.0"
__all__ = ["GENESIS", "CorruptLog", "Engine", "FaultInject", "canonical",
           "payload_of", "record_hash", "__version__"]
