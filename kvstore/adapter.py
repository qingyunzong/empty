"""Injectable file adapter.

All durable I/O goes through a FileAdapter so tests can simulate crashes at
every persistence boundary: log write, log sync, page write, page sync and
checkpoint publish. Engine-level boundaries (CLR flush, undo completion,
checkpoint publish) are signalled through the same FaultController.
"""

from __future__ import annotations

import os

from .errors import CrashError


class FileAdapter:
    """Abstract file adapter interface."""

    def read(self, path: str) -> bytes:
        raise NotImplementedError

    def pread(self, path: str, offset: int, length: int) -> bytes:
        raise NotImplementedError

    def append(self, path: str, data: bytes) -> None:
        raise NotImplementedError

    def write(self, path: str, data: bytes) -> None:
        raise NotImplementedError

    def pwrite(self, path: str, offset: int, data: bytes) -> None:
        raise NotImplementedError

    def sync(self, path: str) -> None:
        raise NotImplementedError

    def exists(self, path: str) -> bool:
        raise NotImplementedError


class RealAdapter(FileAdapter):
    """Adapter backed by the real filesystem."""

    def read(self, path: str) -> bytes:
        if not os.path.exists(path):
            return b""
        with open(path, "rb") as fh:
            return fh.read()

    def pread(self, path: str, offset: int, length: int) -> bytes:
        if not os.path.exists(path):
            return b""
        with open(path, "rb") as fh:
            fh.seek(offset)
            return fh.read(length)

    def append(self, path: str, data: bytes) -> None:
        with open(path, "ab") as fh:
            fh.write(data)

    def write(self, path: str, data: bytes) -> None:
        with open(path, "wb") as fh:
            fh.write(data)

    def pwrite(self, path: str, offset: int, data: bytes) -> None:
        if not os.path.exists(path):
            with open(path, "wb"):
                pass
        with open(path, "r+b") as fh:
            fh.seek(offset)
            fh.write(data)

    def sync(self, path: str) -> None:
        if not os.path.exists(path):
            return
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def exists(self, path: str) -> bool:
        return os.path.exists(path)


class FaultController:
    """Arms crash/torn-write faults at named persistence boundaries."""

    def __init__(self) -> None:
        self._armed: dict[str, int] = {}
        self.torn_next_append = False
        self.counts: dict[str, int] = {}

    def arm(self, name: str, after: int = 1) -> None:
        """Crash when boundary `name` is hit for the `after`-th time."""
        self._armed[name] = after

    def disarm(self) -> None:
        self._armed.clear()
        self.torn_next_append = False

    def arm_torn_append(self) -> None:
        """Next log append writes only half its bytes, then crashes."""
        self.torn_next_append = True

    def hit(self, name: str) -> None:
        self.counts[name] = self.counts.get(name, 0) + 1
        if name in self._armed:
            self._armed[name] -= 1
            if self._armed[name] <= 0:
                del self._armed[name]
                raise CrashError(f"injected crash at boundary '{name}'")


class FaultyAdapter(RealAdapter):
    """RealAdapter that consults a FaultController at I/O boundaries."""

    def __init__(self, faults: FaultController) -> None:
        self.faults = faults

    def append(self, path: str, data: bytes) -> None:
        if path.endswith("wal.log"):
            self.faults.hit("log_write")
            if self.faults.torn_next_append:
                self.faults.torn_next_append = False
                partial = data[: max(1, len(data) // 2)]
                super().append(path, partial)
                raise CrashError("injected crash: torn log append")
        super().append(path, data)

    def pwrite(self, path: str, offset: int, data: bytes) -> None:
        if path.endswith("data.db"):
            self.faults.hit("page_write")
        super().pwrite(path, offset, data)

    def sync(self, path: str) -> None:
        if path.endswith("wal.log"):
            self.faults.hit("log_sync")
        elif path.endswith("data.db"):
            self.faults.hit("page_sync")
        super().sync(path)
