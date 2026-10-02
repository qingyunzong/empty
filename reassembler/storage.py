"""Backing storage for assembled bytes.

Small transfers stay in memory; once the declared total length exceeds
the configured threshold the transfer spills to a sparse temporary file
so memory usage stays bounded regardless of file size.
"""

from __future__ import annotations

import os
import tempfile
from typing import Optional


class Storage:
    """Random-access byte sink interface."""

    def write(self, offset: int, data: bytes) -> None:
        raise NotImplementedError

    def read(self, offset: int, length: int) -> bytes:
        raise NotImplementedError

    def read_all(self) -> bytes:
        raise NotImplementedError

    def size(self) -> int:
        raise NotImplementedError

    def close(self) -> None:
        pass

    def cleanup(self) -> None:
        self.close()


class MemoryStorage(Storage):
    def __init__(self) -> None:
        self._buf = bytearray()

    def write(self, offset: int, data: bytes) -> None:
        end = offset + len(data)
        if end > len(self._buf):
            self._buf.extend(b"\x00" * (end - len(self._buf)))
        self._buf[offset:end] = data

    def read(self, offset: int, length: int) -> bytes:
        return bytes(self._buf[offset:offset + length])

    def read_all(self) -> bytes:
        return bytes(self._buf)

    def size(self) -> int:
        return len(self._buf)


class SparseFileStorage(Storage):
    """Sparse temp file; holes read back as zeros without using disk."""

    def __init__(self, directory: str, total: Optional[int] = None) -> None:
        fd, self.path = tempfile.mkstemp(prefix="reassemble-", dir=directory)
        self._fd: Optional[int] = fd
        if total is not None:
            os.ftruncate(self._fd, total)

    def write(self, offset: int, data: bytes) -> None:
        assert self._fd is not None
        os.pwrite(self._fd, data, offset)

    def read(self, offset: int, length: int) -> bytes:
        assert self._fd is not None
        return os.pread(self._fd, length, offset)

    def read_all(self) -> bytes:
        size = self.size()
        return self.read(0, size) if size else b""

    def size(self) -> int:
        assert self._fd is not None
        return os.fstat(self._fd).st_size

    def close(self) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None

    def cleanup(self) -> None:
        self.close()
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
