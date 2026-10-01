"""Error types for kvstore.

Every expected failure carries a stable machine-readable code:
  E_TXN     - transaction misuse (no active txn, nesting too deep, ...)
  E_IO      - storage / injected I/O failures (append, fsync, ...)
  E_CORRUPT - unrecoverable log corruption (e.g. bad file header)
"""


class KVError(Exception):
    """Base class for all expected kvstore failures."""

    code = "E_IO"

    def __init__(self, message=""):
        super().__init__(message)
        self.message = message


class TxnError(KVError):
    code = "E_TXN"


class StorageError(KVError):
    code = "E_IO"


class CorruptError(KVError):
    code = "E_CORRUPT"


class CrashFault(Exception):
    """Simulated process crash raised at an injected crash fault point.

    This is deliberately NOT a KVError: it models an abrupt process death,
    not a handled error. Callers are expected to re-open the store with
    recovery to observe the post-crash state.
    """

    def __init__(self, point):
        super().__init__("simulated crash at fault point: %s" % point)
        self.point = point
