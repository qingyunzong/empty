"""waldb: a tiny write-ahead-log key-value store.

File format:
    header:  u64 generation
    frame:   u32 length | u32 crc32 | u8 type | payload
             length covers (type + payload); crc32 covers (type + payload)
    types:   PUT=1 (payload: u32 klen, key, value)
             DEL=2 (payload: u32 klen, key)
             COMMIT=3 (empty payload)

Write order for a transaction:
    append PUT/DEL frames -> flush -> os.fsync
    -> append COMMIT frame -> flush -> os.fsync

Recovery:
    - header shorter than u64 -> empty db (header rewritten)
    - scan frames; first length/crc/type error -> truncate at that offset
    - a transaction is applied only if its COMMIT frame is intact
    - trailing frames after the last COMMIT (uncommitted) are truncated
"""

import os
import struct
import sys
import zlib

HEADER_SIZE = 8
TYPE_PUT = 1
TYPE_DEL = 2
TYPE_COMMIT = 3
MAX_FRAME_LEN = 64 * 1024 * 1024

_U32 = struct.Struct("<I")
_FRAME_HDR = struct.Struct("<II")
_GENERATION = struct.Struct("<Q")


class WalError(Exception):
    pass


def _frame(ftype, payload=b""):
    body = bytes([ftype]) + payload
    return _FRAME_HDR.pack(len(body), zlib.crc32(body) & 0xFFFFFFFF) + body


def encode_put(key, value):
    kb = key.encode("utf-8")
    vb = value.encode("utf-8")
    return _frame(TYPE_PUT, _U32.pack(len(kb)) + kb + vb)


def encode_del(key):
    kb = key.encode("utf-8")
    return _frame(TYPE_DEL, _U32.pack(len(kb)) + kb)


def encode_commit():
    return _frame(TYPE_COMMIT)


def init_db(path, generation=1):
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(_GENERATION.pack(generation))
            f.flush()
            os.fsync(f.fileno())


def _parse_put(payload):
    if len(payload) < 4:
        raise WalError("malformed PUT payload")
    (klen,) = _U32.unpack_from(payload, 0)
    if len(payload) < 4 + klen:
        raise WalError("malformed PUT payload")
    key = payload[4:4 + klen].decode("utf-8")
    value = payload[4 + klen:].decode("utf-8")
    return key, value


def _parse_del(payload):
    if len(payload) < 4:
        raise WalError("malformed DEL payload")
    (klen,) = _U32.unpack_from(payload, 0)
    if len(payload) != 4 + klen:
        raise WalError("malformed DEL payload")
    return payload[4:4 + klen].decode("utf-8")


def recover(path):
    """Recover the db file in place; return the replayed state dict."""
    init_db(path)
    with open(path, "rb") as f:
        data = f.read()

    if len(data) < HEADER_SIZE:
        # corrupt header -> empty db
        with open(path, "wb") as f:
            f.write(_GENERATION.pack(1))
            f.flush()
            os.fsync(f.fileno())
        return {}

    state = {}
    pending = []
    offset = HEADER_SIZE
    valid_end = HEADER_SIZE  # end of last COMMIT frame

    while offset < len(data):
        if offset + _FRAME_HDR.size > len(data):
            break
        length, crc = _FRAME_HDR.unpack_from(data, offset)
        if length < 1 or length > MAX_FRAME_LEN:
            break
        end = offset + _FRAME_HDR.size + length
        if end > len(data):
            break
        body = data[offset + _FRAME_HDR.size:end]
        if zlib.crc32(body) & 0xFFFFFFFF != crc:
            break
        ftype, payload = body[0], body[1:]
        try:
            if ftype == TYPE_COMMIT:
                for op in pending:
                    if op[0] == "put":
                        state[op[1]] = op[2]
                    else:
                        state.pop(op[1], None)
                pending = []
                valid_end = end
            elif ftype == TYPE_PUT:
                key, value = _parse_put(payload)
                pending.append(("put", key, value))
            elif ftype == TYPE_DEL:
                pending.append(("del", _parse_del(payload)))
            else:
                break
        except (WalError, UnicodeDecodeError):
            break
        offset = end

    # Everything past the last COMMIT is uncommitted: dangling frames and
    # any corruption from the crash point onward are truncated away, so a
    # later COMMIT can never resurrect a crashed transaction.
    truncate_to = valid_end
    if truncate_to < len(data):
        with open(path, "r+b") as f:
            f.truncate(truncate_to)
            f.flush()
            os.fsync(f.fileno())
    return state


def append_txn(path, ops):
    """Append one transaction. ops: list of ('put', k, v) or ('del', k)."""
    frames = b""
    for op in ops:
        frames += encode_put(op[1], op[2]) if op[0] == "put" else encode_del(op[1])
    commit = encode_commit()
    with open(path, "ab") as f:
        f.write(frames)
        f.flush()
        os.fsync(f.fileno())
        f.write(commit)
        f.flush()
        os.fsync(f.fileno())


def cmd_put(path, key, value):
    recover(path)
    append_txn(path, [("put", key, value)])


def cmd_del(path, key):
    recover(path)
    append_txn(path, [("del", key)])


def cmd_get(path, key):
    state = recover(path)
    if key not in state:
        raise WalError("key not found: %r" % key)
    print(state[key])


def cmd_dump(path):
    state = recover(path)
    for key in sorted(state):
        print("%s=%s" % (key, state[key]))


def cmd_recover(path):
    recover(path)


USAGE = "usage: waldb.py <put|del|get|recover|dump> <db> [key] [value]"


def main(argv):
    if len(argv) < 3:
        raise WalError(USAGE)
    cmd, path = argv[1], argv[2]
    if cmd == "put" and len(argv) == 5:
        cmd_put(path, argv[3], argv[4])
    elif cmd == "del" and len(argv) == 4:
        cmd_del(path, argv[3])
    elif cmd == "get" and len(argv) == 4:
        cmd_get(path, argv[3])
    elif cmd == "recover" and len(argv) == 3:
        cmd_recover(path)
    elif cmd == "dump" and len(argv) == 3:
        cmd_dump(path)
    else:
        raise WalError(USAGE)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except WalError as exc:
        print("error: %s" % exc, file=sys.stderr)
        sys.exit(5)
    except OSError as exc:
        print("error: %s" % exc, file=sys.stderr)
        sys.exit(5)
