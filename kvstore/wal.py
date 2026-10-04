"""Write-ahead log: record encoding, parsing and the log manager.

Record layout (little endian)::

    magic(2) type(1) lsn(8) txid(8) prevLSN(8) pageID(4) undoNextLSN(8)
    payloadLen(4) payload(payloadLen, JSON) crc32(4)

LSN is the logical byte offset of the record in the log stream. Prefix
reclamation advances ``log_base``; the on-disk file only holds bytes for
LSNs >= log_base, and record LSN fields stay absolute.
"""

from __future__ import annotations

import json
import struct
import zlib
from dataclasses import dataclass

from .errors import CorruptLogError

MAGIC = b"LR"
HEADER = struct.Struct("<2sBqqqiqI")
CRC = struct.Struct("<I")
NIL_LSN = -1

UPDATE = 1
COMMIT = 2
END = 3
CLR = 4
CHECKPOINT = 5

TYPE_NAMES = {UPDATE: "UPDATE", COMMIT: "COMMIT", END: "END",
              CLR: "CLR", CHECKPOINT: "CHECKPOINT"}


@dataclass
class LogRecord:
    rtype: int
    lsn: int
    txid: int
    prev_lsn: int
    page_id: int
    undo_next: int
    payload: dict
    size: int = 0

    @property
    def type_name(self) -> str:
        return TYPE_NAMES[self.rtype]


def encode_record(rec: LogRecord) -> bytes:
    payload = json.dumps(rec.payload, sort_keys=True).encode("utf-8")
    header = HEADER.pack(MAGIC, rec.rtype, rec.lsn, rec.txid, rec.prev_lsn,
                         rec.page_id, rec.undo_next, len(payload))
    blob = header + payload
    rec.size = len(blob) + CRC.size
    return blob + CRC.pack(zlib.crc32(blob))


def _valid_record_at(data: bytes, off: int, base_lsn: int) -> bool:
    if off + HEADER.size + CRC.size > len(data):
        return False
    magic, rtype, lsn, _txid, _prev, _page, _undo, plen = HEADER.unpack_from(data, off)
    if magic != MAGIC or rtype not in TYPE_NAMES or lsn != base_lsn + off:
        return False
    end = off + HEADER.size + plen + CRC.size
    if end > len(data):
        return False
    (stored,) = CRC.unpack_from(data, end - CRC.size)
    return stored == zlib.crc32(data[off:end - CRC.size])


def _has_valid_record_after(data: bytes, start: int, base_lsn: int) -> bool:
    for off in range(start, len(data) - HEADER.size - CRC.size + 1):
        if data[off:off + 2] == MAGIC and _valid_record_at(data, off, base_lsn):
            return True
    return False


def parse_log(data: bytes, base_lsn: int):
    """Parse log bytes starting at logical offset ``base_lsn``.

    Returns ``(records, valid_len, tail_status)``. ``tail_status`` is None
    when the buffer parsed cleanly, else "incomplete_tail" or "torn_tail"
    and the file may be truncated at ``valid_len``. A CRC/magic failure
    followed by further valid records is mid-log corruption and raises
    CorruptLogError; the file is left untouched in that case.
    """
    records: list[LogRecord] = []
    off = 0
    while off < len(data):
        if len(data) - off < HEADER.size + CRC.size:
            return records, off, "incomplete_tail"
        magic, rtype, lsn, txid, prev, page, undo_next, plen = HEADER.unpack_from(data, off)
        if magic != MAGIC or rtype not in TYPE_NAMES or lsn != base_lsn + off:
            if _has_valid_record_after(data, off + 1, base_lsn):
                raise CorruptLogError(
                    f"log corruption at LSN {base_lsn + off}: bad magic/type/LSN "
                    f"with valid records afterwards; file left untouched")
            return records, off, "torn_tail"
        end = off + HEADER.size + plen + CRC.size
        if end > len(data):
            return records, off, "incomplete_tail"
        (stored,) = CRC.unpack_from(data, end - CRC.size)
        if stored != zlib.crc32(data[off:end - CRC.size]):
            if _has_valid_record_after(data, off + 1, base_lsn):
                raise CorruptLogError(
                    f"log corruption at LSN {base_lsn + off}: CRC mismatch "
                    f"with valid records afterwards; file left untouched")
            return records, off, "torn_tail"
        payload = json.loads(data[off + HEADER.size:off + HEADER.size + plen])
        records.append(LogRecord(rtype, lsn, txid, prev, page, undo_next,
                                 payload, end - off))
        off = end
    return records, off, None


class LogManager:
    """Append-only log with an in-memory tail buffer and prefix reclamation."""

    def __init__(self, adapter, path: str) -> None:
        self.adapter = adapter
        self.path = path
        self.base = 0
        self.next_lsn = 0
        self.buffer = bytearray()
        self.records: dict[int, LogRecord] = {}

    def open(self, base_lsn: int):
        """Load records from disk; truncate a torn/incomplete tail."""
        self.base = base_lsn
        data = self.adapter.read(self.path)
        records, valid_len, status = parse_log(data, base_lsn)
        if status is not None:
            self.adapter.write(self.path, data[:valid_len])
            self.adapter.sync(self.path)
        self.next_lsn = base_lsn + valid_len
        self.records = {rec.lsn: rec for rec in records}
        return records, status

    def append(self, rtype: int, txid: int, prev_lsn: int, page_id: int,
               payload: dict, undo_next: int = NIL_LSN) -> LogRecord:
        rec = LogRecord(rtype, self.next_lsn, txid, prev_lsn, page_id,
                        undo_next, payload)
        blob = encode_record(rec)
        self.buffer += blob
        self.next_lsn += len(blob)
        self.records[rec.lsn] = rec
        return rec

    def flush(self, sync: bool = True) -> None:
        if self.buffer:
            self.adapter.append(self.path, bytes(self.buffer))
            self.buffer.clear()
        if sync:
            self.adapter.sync(self.path)

    def truncate_prefix(self, point: int) -> bool:
        """Drop all log bytes before LSN ``point`` (already durable elsewhere)."""
        if point <= self.base:
            return False
        data = self.adapter.read(self.path)
        keep_from = max(0, point - self.base)
        self.adapter.write(self.path, data[keep_from:])
        self.adapter.sync(self.path)
        self.base = point
        return True
