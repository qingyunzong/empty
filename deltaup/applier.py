"""Streaming delta applier with checkpointed resume and atomic publish.

Memory discipline: only the last ``window_size`` output bytes (at most
64 KiB by default) are kept in memory; older output lives in a temporary
file accessed with ``os.pread``/``os.pwrite``.  The baseline is read
through random-access chunked reads and is never loaded whole.

After every verified instruction boundary a checkpoint is written
atomically.  Resuming re-verifies the baseline fingerprint and the
temporary output prefix (length + rolling CRC32) before consuming the
rest of the stream.  The target file is replaced (``os.replace``) only
after every block hash and the final total hash verify.
"""

from __future__ import annotations

import hashlib
import json
import os
import zlib

from .decoder import Decoder
from .errors import (
    BaselineMismatchError,
    ChecksumMismatchError,
    CopyBaseOutOfRangeError,
    CopyOutUngeneratedError,
    LengthMismatchError,
    LengthOverflowError,
    ResumeError,
    TempOutputMismatchError,
    UnexpectedEndError,
)

WINDOW_SIZE = 1 << 16  # 64 KiB
IO_CHUNK = 1 << 16
CHECKPOINT_VERSION = 1
_CHECKPOINT_EVENTS = frozenset(
    {"header", "block_header", "add_end", "copy_base", "copy_out", "block_end"}
)


class EventLimitReached(Exception):
    """Testing hook: raised to simulate a crash after N checkpointed events."""


def _fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _hash_file_prefix(fd, length, hasher_factory=hashlib.sha256, crc=0):
    """Return ``(digest_hasher, crc32)`` over the first ``length`` bytes."""
    hasher = hasher_factory()
    pos = 0
    while pos < length:
        chunk = os.pread(fd, min(IO_CHUNK, length - pos), pos)
        if not chunk:
            break
        hasher.update(chunk)
        crc = zlib.crc32(chunk, crc)
        pos += len(chunk)
    return hasher, crc


class Applier:
    def __init__(
        self,
        baseline_path,
        target_path,
        *,
        window_size=WINDOW_SIZE,
        checkpoint_path=None,
        temp_path=None,
        event_limit=None,
    ):
        self.baseline_path = os.fspath(baseline_path)
        self.target_path = os.fspath(target_path)
        target_dir = os.path.dirname(os.path.abspath(self.target_path))
        base = os.path.basename(self.target_path)
        self.temp_path = temp_path or os.path.join(target_dir, "." + base + ".part")
        self.checkpoint_path = checkpoint_path or os.path.join(
            target_dir, "." + base + ".ckpt"
        )
        self.window_size = window_size
        self.event_limit = event_limit
        self.decoder = Decoder()
        self.fd = os.open(self.temp_path, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
        self.baseline_fd = None
        self.baseline_len = None
        self.baseline_sha = None
        self.out_len = 0
        self.window = bytearray()
        self.crc = 0
        self.sha_total = hashlib.sha256()
        self.block_sha = None
        self.block_out_start = 0
        self.block_out_remaining = 0
        self.expected_block_sha = None
        self.input_offset = 0
        self.event_count = 0
        self.done = False
        # A fresh apply invalidates any stale checkpoint from a crashed run.
        if os.path.exists(self.checkpoint_path):
            os.unlink(self.checkpoint_path)

    # ------------------------------------------------------------------ API

    def feed(self, data):
        """Feed a stream slice; returns bytes needed to finish current unit."""
        needed = self.decoder.feed(data)
        self._drain_events()
        return needed

    def finish(self):
        if not self.done:
            raise UnexpectedEndError(
                f"stream truncated; decoder needs {self.decoder.needed()} more bytes"
            )

    def close(self):
        for fd in (self.fd, self.baseline_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        self.fd = None
        self.baseline_fd = None

    # -------------------------------------------------------------- resume

    @classmethod
    def resume(cls, baseline_path, target_path, checkpoint_path):
        """Rebuild an applier from a checkpoint, verifying all prior state."""
        try:
            with open(checkpoint_path, "r", encoding="utf-8") as fh:
                st = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            raise ResumeError(f"cannot load checkpoint: {exc}") from exc
        if st.get("version") != CHECKPOINT_VERSION:
            raise ResumeError("unsupported checkpoint version")

        obj = cls.__new__(cls)
        obj.baseline_path = os.fspath(baseline_path)
        obj.target_path = os.fspath(target_path)
        obj.temp_path = st["temp_path"]
        obj.checkpoint_path = os.fspath(checkpoint_path)
        obj.window_size = st["window_size"]
        obj.event_limit = None
        obj.decoder = Decoder.from_state(st["decoder"], st["input_offset"])
        obj.input_offset = st["input_offset"]
        obj.out_len = st["out_len"]
        obj.block_out_start = st["block_out_start"]
        obj.block_out_remaining = st["block_out_remaining"]
        expected = st["expected_block_sha256"]
        obj.expected_block_sha = bytes.fromhex(expected) if expected else None
        obj.event_count = 0
        obj.done = False
        obj.fd = None
        obj.baseline_fd = None

        # 1. Verify the baseline fingerprint before anything else.
        obj.baseline_len = st["decoder"]["baseline_len"]
        obj.baseline_sha = bytes.fromhex(st["decoder"]["baseline_sha256"])
        obj._verify_baseline()

        # 2. Verify the temporary output prefix (length + rolling CRC32).
        try:
            obj.fd = os.open(obj.temp_path, os.O_RDWR)
        except OSError as exc:
            raise TempOutputMismatchError(
                f"temporary output missing: {exc}"
            ) from exc
        if os.path.getsize(obj.temp_path) != obj.out_len:
            obj.close()
            raise TempOutputMismatchError("temporary output length mismatch")
        hasher, crc = _hash_file_prefix(obj.fd, obj.out_len)
        if crc != st["crc32"]:
            obj.close()
            raise TempOutputMismatchError("temporary output checksum mismatch")
        obj.sha_total = hasher
        obj.crc = crc

        # 3. Rebuild the in-progress block hash from the verified prefix.
        if st["decoder"]["phase"] == "instructions":
            block_hasher, _ = _hash_file_prefix(obj.fd, 0)
            pos = obj.block_out_start
            while pos < obj.out_len:
                chunk = os.pread(obj.fd, min(IO_CHUNK, obj.out_len - pos), pos)
                block_hasher.update(chunk)
                pos += len(chunk)
            obj.block_sha = block_hasher
        else:
            obj.block_sha = None

        # 4. Rebuild the in-memory window from the tail of the temp file.
        wlen = min(obj.window_size, obj.out_len)
        obj.window = bytearray(os.pread(obj.fd, wlen, obj.out_len - wlen))
        obj.baseline_fd = os.open(obj.baseline_path, os.O_RDONLY)
        return obj

    # ------------------------------------------------------------- events

    def _drain_events(self):
        while self.decoder.events:
            offset, name, args, state = self.decoder.events.popleft()
            self._handle(name, args)
            if name in _CHECKPOINT_EVENTS:
                self.input_offset = offset
                self._write_checkpoint(state)
                self.event_count += 1
                if (
                    self.event_limit is not None
                    and self.event_count >= self.event_limit
                ):
                    raise EventLimitReached(
                        f"simulated crash after {self.event_count} events"
                    )

    def _handle(self, name, args):
        if name == "header":
            baseline_len, baseline_sha, _block_count = args
            self.baseline_len = baseline_len
            self.baseline_sha = baseline_sha
            self._verify_baseline()
            self.baseline_fd = os.open(self.baseline_path, os.O_RDONLY)
        elif name == "block_header":
            _index, out_len, sha, _instr_len = args
            self.expected_block_sha = sha
            self.block_out_start = self.out_len
            self.block_out_remaining = out_len
            self.block_sha = hashlib.sha256()
        elif name == "add_begin":
            (length,) = args
            if length > self.block_out_remaining:
                raise LengthOverflowError(
                    "ADD output exceeds declared block length"
                )
        elif name == "add_data":
            (chunk,) = args
            self._write(chunk)
        elif name == "add_end":
            pass
        elif name == "copy_base":
            offset, length = args
            if offset + length > self.baseline_len:
                raise CopyBaseOutOfRangeError(
                    f"COPY_BASE [{offset}, {offset + length}) beyond "
                    f"baseline length {self.baseline_len}"
                )
            if length > self.block_out_remaining:
                raise LengthOverflowError(
                    "COPY_BASE output exceeds declared block length"
                )
            self._copy_from_baseline(offset, length)
        elif name == "copy_out":
            offset, length = args
            if length and offset >= self.out_len:
                raise CopyOutUngeneratedError(
                    f"COPY_OUT from offset {offset} but only "
                    f"{self.out_len} output bytes generated"
                )
            if length > self.block_out_remaining:
                raise LengthOverflowError(
                    "COPY_OUT output exceeds declared block length"
                )
            self._copy_from_output(offset, length)
        elif name == "block_end":
            if self.block_out_remaining != 0:
                raise LengthMismatchError(
                    f"block produced "
                    f"{self.block_out_remaining} fewer bytes than declared"
                )
            if self.block_sha.digest() != self.expected_block_sha:
                raise ChecksumMismatchError("block hash mismatch")
        elif name == "trailer":
            total_len, total_sha = args
            if total_len != self.out_len:
                raise LengthMismatchError(
                    f"total length {self.out_len} != declared {total_len}"
                )
            if self.sha_total.digest() != total_sha:
                raise ChecksumMismatchError("total hash mismatch")
            self._publish()
        elif name == "done":
            pass

    # ------------------------------------------------------------- output

    def _write(self, data):
        os.pwrite(self.fd, data, self.out_len)
        self.window += data
        if len(self.window) > self.window_size:
            del self.window[: len(self.window) - self.window_size]
        self.crc = zlib.crc32(data, self.crc)
        self.sha_total.update(data)
        self.block_sha.update(data)
        self.out_len += len(data)
        self.block_out_remaining -= len(data)

    def _read_output(self, pos, n):
        window_start = self.out_len - len(self.window)
        if pos >= window_start:
            return bytes(self.window[pos - window_start : pos - window_start + n])
        from_file = min(n, window_start - pos)
        data = os.pread(self.fd, from_file, pos)
        rest = n - from_file
        if rest:
            data += bytes(self.window[:rest])
        return data

    def _copy_from_baseline(self, offset, length):
        pos = offset
        end = offset + length
        while pos < end:
            chunk = os.pread(self.baseline_fd, min(IO_CHUNK, end - pos), pos)
            if not chunk:
                raise CopyBaseOutOfRangeError("baseline read past end of file")
            self._write(chunk)
            pos += len(chunk)

    def _copy_from_output(self, offset, length):
        # Byte-by-byte forward semantics, chunked: at each step only bytes
        # already generated are read, so overlapping copies replicate.
        remaining = length
        src = offset
        while remaining:
            distance = self.out_len - src
            n = min(remaining, distance, IO_CHUNK)
            self._write(self._read_output(src, n))
            src += n
            remaining -= n

    # --------------------------------------------------------- checkpoint

    def _write_checkpoint(self, decoder_state):
        os.fsync(self.fd)
        state = {
            "version": CHECKPOINT_VERSION,
            "temp_path": self.temp_path,
            "input_offset": self.input_offset,
            "out_len": self.out_len,
            "crc32": self.crc,
            "window_size": self.window_size,
            "block_out_start": self.block_out_start,
            "block_out_remaining": self.block_out_remaining,
            "expected_block_sha256": self.expected_block_sha.hex()
            if self.expected_block_sha is not None
            else None,
            "decoder": decoder_state,
        }
        tmp = self.checkpoint_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.checkpoint_path)
        _fsync_dir(os.path.dirname(os.path.abspath(self.checkpoint_path)))

    # -------------------------------------------------------- verification

    def _verify_baseline(self):
        try:
            size = os.path.getsize(self.baseline_path)
        except OSError as exc:
            raise BaselineMismatchError(f"baseline unreadable: {exc}") from exc
        if size != self.baseline_len:
            raise BaselineMismatchError(
                f"baseline length {size} != expected {self.baseline_len}"
            )
        hasher = hashlib.sha256()
        with open(self.baseline_path, "rb") as fh:
            while True:
                chunk = fh.read(IO_CHUNK)
                if not chunk:
                    break
                hasher.update(chunk)
        if hasher.digest() != self.baseline_sha:
            raise BaselineMismatchError("baseline fingerprint mismatch")

    # ------------------------------------------------------------ publish

    def _publish(self):
        os.fsync(self.fd)
        os.close(self.fd)
        self.fd = None
        if self.baseline_fd is not None:
            os.close(self.baseline_fd)
            self.baseline_fd = None
        os.replace(self.temp_path, self.target_path)
        _fsync_dir(os.path.dirname(os.path.abspath(self.target_path)))
        if os.path.exists(self.checkpoint_path):
            os.unlink(self.checkpoint_path)
        self.done = True


# ------------------------------------------------------------ convenience


def apply_delta(
    baseline_path,
    delta_path,
    target_path,
    *,
    window_size=WINDOW_SIZE,
    checkpoint_path=None,
    event_limit=None,
):
    """Apply a whole delta file, checkpointing after every instruction."""
    applier = Applier(
        baseline_path,
        target_path,
        window_size=window_size,
        checkpoint_path=checkpoint_path,
        event_limit=event_limit,
    )
    try:
        with open(delta_path, "rb") as fh:
            while True:
                chunk = fh.read(IO_CHUNK)
                if not chunk:
                    break
                applier.feed(chunk)
        applier.finish()
    finally:
        applier.close()
    return {"bytes_written": applier.out_len}


def resume_delta(baseline_path, delta_path, target_path, checkpoint_path):
    """Resume an interrupted apply from its checkpoint."""
    applier = Applier.resume(baseline_path, target_path, checkpoint_path)
    try:
        with open(delta_path, "rb") as fh:
            fh.seek(applier.input_offset)
            while True:
                chunk = fh.read(IO_CHUNK)
                if not chunk:
                    break
                applier.feed(chunk)
        applier.finish()
    finally:
        applier.close()
    return {"bytes_written": applier.out_len}
