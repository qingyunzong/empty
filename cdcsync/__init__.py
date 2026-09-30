"""cdcsync: apply JSONL change logs to a SQLite KV store, exactly once."""
from .core import (
    FaultInject,
    LogValidationError,
    apply_log,
    chain_events,
    dump_kv,
    dumps_log,
    parse_and_validate,
)

__version__ = "0.1.0"

__all__ = [
    "FaultInject",
    "LogValidationError",
    "apply_log",
    "chain_events",
    "dump_kv",
    "dumps_log",
    "parse_and_validate",
    "__version__",
]
