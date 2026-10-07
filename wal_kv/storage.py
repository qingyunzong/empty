"""Storage adapters with fault injection.

The adapter models the boundary between volatile OS buffers and durable
storage: log appends stay volatile until ``sync_log``; page writes model
flushes and are durable immediately.  ``crash()`` drops volatile log data,
emulating a power failure.
"""

BOUNDARIES = ("log_write", "log_sync", "page_write", "clr_write", "ckpt_publish")


class CrashError(Exception):
    """Raised when an injected fault simulates a crash at a boundary."""


class LogCorruptionError(Exception):
    """Raised when the log has checksum damage in the middle of the file.

    The file is left untouched so an operator can inspect/repair it.
    """

    def __init__(self, offset, reason):
        self.offset = offset
        self.reason = reason
        super().__init__(f"log corruption at offset {offset}: {reason}")


class InMemoryFileAdapter:
    """File adapter keeping durable bytes in memory, with fault hooks.

    Faults are armed per boundary with ``arm(boundary, at_call)``: the
    Nth invocation of that boundary raises :class:`CrashError` instead of
    performing the operation.
    """

    def __init__(self):
        self._durable_log = b""
        self._volatile_log = bytearray()
        self._pages = {}
        self._faults = {}
        self._counts = {b: 0 for b in BOUNDARIES}

    # -- fault injection -------------------------------------------------
    def arm(self, boundary, at_call):
        if boundary not in BOUNDARIES:
            raise ValueError(f"unknown boundary {boundary!r}")
        self._faults.setdefault(boundary, []).append(at_call)

    def _maybe_fail(self, boundary):
        self._counts[boundary] += 1
        pending = self._faults.get(boundary)
        if pending and self._counts[boundary] in pending:
            pending.remove(self._counts[boundary])
            raise CrashError(
                f"injected crash at {boundary} call #{self._counts[boundary]}"
            )

    # -- log --------------------------------------------------------------
    def append_log(self, frame, boundary="log_write"):
        self._maybe_fail(boundary)
        self._volatile_log += frame

    def sync_log(self):
        self._maybe_fail("log_sync")
        self._durable_log += bytes(self._volatile_log)
        self._volatile_log.clear()

    def read_log(self):
        return self._durable_log

    def rewrite_log(self, data):
        """Atomically replace the durable log (prefix recycling / truncation)."""
        self._durable_log = bytes(data)
        self._volatile_log.clear()

    # -- pages ------------------------------------------------------------
    def write_page(self, page_id, data):
        self._maybe_fail("page_write")
        self._pages[page_id] = bytes(data)

    def read_page(self, page_id):
        return self._pages.get(page_id)

    # -- crash ------------------------------------------------------------
    def crash(self):
        """Simulate power loss: volatile (unsynced) log data is gone."""
        self._volatile_log.clear()
