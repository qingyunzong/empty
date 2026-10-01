"""waldb - a tiny write-ahead-log key-value store.

On-disk format
--------------
Header:  u64 generation (little-endian), 8 bytes.
Frame:   u32 length, u32 crc32, u8 type, payload.
         ``length`` counts the type byte plus payload bytes;
         ``crc32`` is computed over those same bytes.
Types:   PUT (1), DEL (2), COMMIT (3).

PUT payload:  u32 klen, key bytes, u32 vlen, value bytes.
DEL payload:  u32 klen, key bytes.
COMMIT:       no payload (length == 1).

Write protocol
--------------
1. append all data frames of the transaction
2. flush + os.fsync
3. append the COMMIT frame
4. flush + os.fsync

Recovery
--------
Scan frames from the end of the header.  Stop at the first frame with a
bad length or bad crc and truncate the file there.  Frames not followed
by a COMMIT belong to an incomplete transaction and are discarded, so
the file is truncated to the end of the last complete COMMIT frame.
If the header itself is damaged (fewer than 8 bytes) the database is
reset to empty with a fresh generation.
"""

from __future__ import annotations

import argparse
import os
import struct
import sys
import zlib

HEADER_STRUCT = struct.Struct("<Q")         # u64 generation
FRAME_HEADER_STRUCT = struct.Struct("<II")  # u32 length, u32 crc32
UINT32_STRUCT = struct.Struct("<I")

TYPE_PUT = 1
TYPE_DEL = 2
TYPE_COMMIT = 3

HEADER_SIZE = HEADER_STRUCT.size
FRAME_HEADER_SIZE = FRAME_HEADER_STRUCT.size

EXIT_ERROR = 5


class WaldbError(Exception):
    """User-facing database error (CLI exits with status 5)."""


class _Corrupt(Exception):
    """Internal: frame payload failed to decode."""


# --------------------------------------------------------------------------
# frame encoding / decoding
# --------------------------------------------------------------------------

def encode_frame(payload: bytes) -> bytes:
    """Wrap a type+payload blob with its length and crc32 header."""
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    return FRAME_HEADER_STRUCT.pack(len(payload), crc) + payload


def encode_put(key: bytes, value: bytes) -> bytes:
    payload = (
        bytes([TYPE_PUT])
        + UINT32_STRUCT.pack(len(key)) + key
        + UINT32_STRUCT.pack(len(value)) + value
    )
    return encode_frame(payload)


def encode_del(key: bytes) -> bytes:
    payload = bytes([TYPE_DEL]) + UINT32_STRUCT.pack(len(key)) + key
    return encode_frame(payload)


def encode_commit() -> bytes:
    return encode_frame(bytes([TYPE_COMMIT]))


def encode_ops(ops) -> bytes:
    """Encode a list of ("put", key, value) / ("del", key) ops (str keys)."""
    out = []
    for op in ops:
        if op[0] == "put":
            out.append(encode_put(op[1].encode("utf-8"), op[2].encode("utf-8")))
        elif op[0] == "del":
            out.append(encode_del(op[1].encode("utf-8")))
        else:
            raise ValueError(f"unknown op: {op[0]!r}")
    return b"".join(out)


def _read_u32(buf: bytes, pos: int):
    if pos + 4 > len(buf):
        raise _Corrupt("truncated u32")
    return UINT32_STRUCT.unpack_from(buf, pos)[0], pos + 4


def _decode_payload(payload: bytes):
    """Return ("commit",) | ("put", key, value) | ("del", key); str keys."""
    ftype = payload[0]
    body = payload[1:]
    if ftype == TYPE_COMMIT:
        if body:
            raise _Corrupt("COMMIT frame with payload")
        return ("commit",)
    if ftype == TYPE_PUT:
        klen, pos = _read_u32(body, 0)
        if pos + klen > len(body):
            raise _Corrupt("truncated key")
        key = body[pos:pos + klen]
        pos += klen
        vlen, pos = _read_u32(body, pos)
        if pos + vlen != len(body):
            raise _Corrupt("bad value length")
        value = body[pos:pos + vlen]
        try:
            return ("put", key.decode("utf-8"), value.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise _Corrupt("invalid utf-8") from exc
    if ftype == TYPE_DEL:
        klen, pos = _read_u32(body, 0)
        if pos + klen != len(body):
            raise _Corrupt("bad key length")
        try:
            return ("del", body[pos:pos + klen].decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise _Corrupt("invalid utf-8") from exc
    raise _Corrupt(f"unknown frame type {ftype}")


def _apply(state: dict, op) -> None:
    if op[0] == "put":
        state[op[1]] = op[2]
    elif op[0] == "del":
        state.pop(op[1], None)


def scan(data: bytes):
    """Replay committed transactions from raw file bytes.

    Returns (state, end_of_last_commit_offset).  Stops at the first
    frame with a bad length, bad crc, or undecodable payload.
    """
    state: dict = {}
    pending: list = []
    offset = HEADER_SIZE
    last_commit_end = HEADER_SIZE
    while offset < len(data):
        if offset + FRAME_HEADER_SIZE > len(data):
            break  # torn frame header
        length, crc = FRAME_HEADER_STRUCT.unpack_from(data, offset)
        frame_end = offset + FRAME_HEADER_SIZE + length
        if length < 1 or frame_end > len(data):
            break  # bad length / torn frame body
        payload = data[offset + FRAME_HEADER_SIZE:frame_end]
        if zlib.crc32(payload) & 0xFFFFFFFF != crc:
            break  # crc mismatch
        try:
            op = _decode_payload(payload)
        except _Corrupt:
            break
        if op[0] == "commit":
            for pending_op in pending:
                _apply(state, pending_op)
            pending.clear()
            last_commit_end = frame_end
        else:
            pending.append(op)
        offset = frame_end
    return state, last_commit_end


# --------------------------------------------------------------------------
# recovery
# --------------------------------------------------------------------------

def _write_all(fd: int, data: bytes) -> None:
    while data:
        written = os.write(fd, data)
        data = data[written:]


def _write_fresh_header(path: str, generation: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        _write_all(fd, HEADER_STRUCT.pack(generation))
        os.fsync(fd)
    finally:
        os.close(fd)


def recover(path: str) -> int:
    """Recover the log file in place; returns the new generation.

    Truncates the file to the end of the last complete COMMIT frame,
    dropping any corrupt tail and any incomplete transaction.  A damaged
    header resets the database to empty.
    """
    try:
        with open(path, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        data = b""

    if len(data) < HEADER_SIZE:
        _write_fresh_header(path, 1)
        return 1

    generation = HEADER_STRUCT.unpack_from(data, 0)[0]
    _state, last_commit_end = scan(data)
    new_generation = generation + 1

    fd = os.open(path, os.O_WRONLY)
    try:
        os.ftruncate(fd, last_commit_end)
        os.lseek(fd, 0, os.SEEK_SET)
        _write_all(fd, HEADER_STRUCT.pack(new_generation))
        os.fsync(fd)
    finally:
        os.close(fd)
    return new_generation


# --------------------------------------------------------------------------
# database
# --------------------------------------------------------------------------

class WalDB:
    """A tiny transactional key-value store backed by the WAL file."""

    def __init__(self, path: str):
        self.path = path
        if not os.path.exists(path):
            _write_fresh_header(path, 1)
        if os.path.getsize(path) < HEADER_SIZE:
            raise WaldbError(
                f"database header is corrupt: {path} (run recover first)"
            )
        with open(path, "rb") as f:
            data = f.read()
        self._state, self._log_end = scan(data)

    def commit(self, ops) -> None:
        """Commit one transaction: data frames, fsync, COMMIT, fsync."""
        frames = encode_ops(ops)
        commit_frame = encode_commit()
        with open(self.path, "ab") as f:
            f.write(frames)
            f.flush()
            os.fsync(f.fileno())
            f.write(commit_frame)
            f.flush()
            os.fsync(f.fileno())
        for op in ops:
            _apply(self._state, op)
        self._log_end += len(frames) + len(commit_frame)

    def put(self, key: str, value: str) -> None:
        self.commit([("put", key, value)])

    def delete(self, key: str) -> None:
        self.commit([("del", key)])

    def get(self, key: str):
        return self._state.get(key)

    def dump(self) -> dict:
        return dict(self._state)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

class _Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"error: {message}", file=sys.stderr)
        sys.exit(EXIT_ERROR)


def _build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default="wal.db", help="database file path")

    parser = _Parser(prog="waldb", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p_put = sub.add_parser("put", parents=[common], help="put k v")
    p_put.add_argument("key")
    p_put.add_argument("value")

    p_del = sub.add_parser("del", parents=[common], help="del k")
    p_del.add_argument("key")

    p_get = sub.add_parser("get", parents=[common], help="get k")
    p_get.add_argument("key")

    sub.add_parser("recover", parents=[common], help="recover the log")
    sub.add_parser("dump", parents=[common], help="dump all key/value pairs")
    return parser


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "recover":
            generation = recover(args.db)
            print(f"recovered: generation={generation}")
            return 0

        db = WalDB(args.db)
        if args.command == "put":
            db.put(args.key, args.value)
            print("OK")
        elif args.command == "del":
            db.delete(args.key)
            print("OK")
        elif args.command == "get":
            value = db.get(args.key)
            if value is None:
                print(f"error: key not found: {args.key}", file=sys.stderr)
                return EXIT_ERROR
            print(value)
        elif args.command == "dump":
            state = db.dump()
            for key in sorted(state):
                print(f"{key}={state[key]}")
        return 0
    except WaldbError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
