"""Bounded-memory output sink backed by a temporary file.

At most ``window_size`` bytes of produced output are kept in memory; anything
older lives in the temporary file and is reached by positioned reads.  The
baseline is likewise only ever read through positioned reads, so neither the
baseline nor the output is ever fully loaded into memory.

Invariant: the file holds output bytes ``[0, file_len)`` and ``_recent``
holds ``[length - len(_recent), length)`` with
``file_len >= length - len(_recent)`` -- i.e. every produced byte is either
in the file or in the in-memory window (or both).
"""

import os

_IO_CHUNK = 1 << 16


class OutputSink:
    def __init__(self, path, window_size: int = 1 << 16):
        self._path = path
        self._window_size = window_size
        self._file = open(path, "w+b")
        self.length = 0
        self._recent = bytearray()
        self._file_len = 0
        self.on_write = None  # hook: called with each bytes chunk written

    # -- construction --------------------------------------------------

    @classmethod
    def resume(cls, path, window_size, length):
        """Reopen an existing temp output, truncating it to ``length``."""
        obj = cls.__new__(cls)
        obj._path = path
        obj._window_size = window_size
        obj._file = open(path, "r+b")
        obj._file.truncate(length)
        obj.length = length
        keep = min(window_size, length)
        obj._file.seek(length - keep)
        obj._recent = bytearray(obj._file.read(keep))
        obj._file_len = length - keep
        obj.on_write = None
        return obj

    @property
    def recent_size(self) -> int:
        return len(self._recent)

    @property
    def window_size(self) -> int:
        return self._window_size

    # -- writing ---------------------------------------------------------

    def write(self, data: bytes):
        if not data:
            return
        if self.on_write is not None:
            self.on_write(data)
        self._recent += data
        self.length += len(data)
        overflow = len(self._recent) - self._window_size
        if overflow > 0:
            self._spill(overflow)

    def _spill(self, count):
        """Move the oldest ``count`` window bytes into the file."""
        recent_start = self.length - len(self._recent)
        if self._file_len < recent_start + count:
            start = max(0, self._file_len - recent_start)
            self._file.seek(self._file_len)
            self._file.write(self._recent[start:count])
            self._file_len = recent_start + count
        del self._recent[:count]

    # -- reading ---------------------------------------------------------

    def read_at(self, pos: int) -> int:
        recent_start = self.length - len(self._recent)
        if pos >= recent_start:
            return self._recent[pos - recent_start]
        self._file.seek(pos)
        byte = self._file.read(1)
        if len(byte) != 1:
            raise IOError(f"temp output short read at {pos}")
        return byte[0]

    def _read_range(self, start: int, count: int) -> bytes:
        recent_start = self.length - len(self._recent)
        if start >= recent_start:
            off = start - recent_start
            return bytes(self._recent[off:off + count])
        if start + count <= recent_start:
            self._file.seek(start)
            data = self._file.read(count)
            if len(data) != count:
                raise IOError("temp output short read")
            return data
        return (self._read_range(start, recent_start - start)
                + self._read_range(recent_start, count - (recent_start - start)))

    # -- copy instructions -------------------------------------------------

    def copy_out(self, distance: int, length: int):
        """Replicate ``length`` bytes from ``length - distance`` onwards.

        Byte-by-byte semantics: chunks are capped at ``distance`` so a chunk
        never reads bytes produced by itself, which is exactly equivalent to
        copying one byte at a time (overlap replicates the pattern).
        """
        remaining = length
        while remaining > 0:
            step = min(distance, remaining)
            data = self._read_range(self.length - distance, step)
            self.write(data)
            remaining -= step

    def copy_from_base(self, base_file, offset: int, length: int):
        base_file.seek(offset)
        remaining = length
        while remaining > 0:
            chunk = base_file.read(min(_IO_CHUNK, remaining))
            if not chunk:
                raise IOError("baseline short read")
            self.write(chunk)
            remaining -= len(chunk)

    # -- durability ---------------------------------------------------------

    def flush(self):
        """Ensure the file holds every produced byte, then fsync."""
        recent_start = self.length - len(self._recent)
        if self._file_len < self.length:
            self._file.seek(self._file_len)
            self._file.write(self._recent[self._file_len - recent_start:])
            self._file_len = self.length
        self._file.flush()
        os.fsync(self._file.fileno())

    def close(self):
        self._file.close()
