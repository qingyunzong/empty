"""Error types and stable error codes for kvstore."""


class KVError(Exception):
    """Base error carrying a stable machine-readable code."""

    code = "E_TXN"

    def __init__(self, message="", code=None):
        super().__init__(message)
        if code is not None:
            self.code = code


class TxnError(KVError):
    """Transaction misuse: bad nesting, no active txn, unknown op."""

    code = "E_TXN"


class StorageError(KVError):
    """I/O failure (real or injected) while appending or syncing."""

    code = "E_IO"


class CorruptError(KVError):
    """Corruption detected in the log."""

    code = "E_CORRUPT"


class CrashSimulation(Exception):
    """Raised to simulate a process crash (crash_after_commit)."""
