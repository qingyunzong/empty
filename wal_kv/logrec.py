"""Log record framing: length + CRC32 + JSON payload.

Frame layout (little endian)::

    uint32 payload_length
    uint32 crc32(payload)
    bytes  payload (JSON object)

The payload always carries ``lsn``, ``txn``, ``prev`` (transaction
predecessor) and ``type``.  Update records carry ``page``/``key`` and
before/after images; CLRs carry ``undo_next``; end-checkpoint records
carry the fuzzy checkpoint's ATT and DPT snapshots.
"""

import json
import struct
import zlib

from .storage import LogCorruptionError

HEADER = struct.Struct("<II")
MAX_PAYLOAD = 8 * 1024 * 1024


def encode_record(rec):
    payload = json.dumps(rec, sort_keys=True, separators=(",", ":")).encode()
    return HEADER.pack(len(payload), zlib.crc32(payload)) + payload


def scan_log(data):
    """Scan durable log bytes.

    Returns ``(records, valid_length)``.  An incomplete or torn record at
    the tail is simply not returned; the caller truncates the file to
    ``valid_length``.  Checksum damage with valid frames beyond it is
    mid-log corruption and raises :class:`LogCorruptionError`; the file
    must be left untouched in that case.
    """
    records = []
    pos = 0
    while pos < len(data):
        remaining = len(data) - pos
        if remaining < HEADER.size:
            break  # torn header at the tail
        length, crc = HEADER.unpack_from(data, pos)
        if length == 0 or length > MAX_PAYLOAD:
            raise LogCorruptionError(pos, f"implausible record length {length}")
        if remaining < HEADER.size + length:
            break  # torn record body at the tail
        payload = data[pos + HEADER.size : pos + HEADER.size + length]
        if zlib.crc32(payload) != crc:
            if pos + HEADER.size + length == len(data):
                break  # torn write of the final record
            raise LogCorruptionError(pos, "crc mismatch in the middle of the log")
        records.append(json.loads(payload.decode()))
        pos += HEADER.size + length
    return records, pos
