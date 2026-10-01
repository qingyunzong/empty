"""Append-only nogood log with CRC32 integrity checks and crash recovery.

On-disk entry format (all integers big-endian)::

    +-------------------+----------------------+------------------+
    | payload length u32 | clause JSON payload | CRC32(payload) u32 |
    +-------------------+----------------------+------------------+

Failure model
-------------
Two explicit failure points are handled at load time:

a) Crash mid-write: the trailing entry is truncated (incomplete header,
   payload, or checksum).  It is treated as never committed.
b) Corruption: the stored CRC32 does not match the payload bytes.

Recovery semantics: the log is parsed sequentially from the start.  The
first truncated or corrupt entry stops the scan immediately; only the
entries committed before it are returned.  A missing or empty log yields
an empty list.
"""

from __future__ import annotations

import json
import os
import struct
import zlib

_HEADER = struct.Struct(">I")  # payload length
_CRC = struct.Struct(">I")     # crc32 of payload


class ClauseFormatError(ValueError):
    """Raised when a nogood clause JSON payload is malformed."""


def canonicalize_clause(clause):
    """Validate a nogood clause and return its canonical JSON string.

    A clause is a non-empty list of literals, each an object with exactly
    the keys ``var`` (non-empty string) and ``value`` (JSON scalar).
    """
    if not isinstance(clause, list) or not clause:
        raise ClauseFormatError(
            "clause must be a non-empty JSON array of literals")
    for literal in clause:
        if not isinstance(literal, dict) or set(literal) != {"var", "value"}:
            raise ClauseFormatError(
                "each literal must be an object with exactly 'var' and 'value'")
        if not isinstance(literal["var"], str) or not literal["var"]:
            raise ClauseFormatError("literal 'var' must be a non-empty string")
        value = literal["value"]
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise ClauseFormatError("literal 'value' must be a JSON scalar")
    return json.dumps(clause, sort_keys=True, separators=(",", ":"))


def parse_clause_json(text):
    """Parse and validate a clause from its JSON text representation."""
    try:
        clause = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ClauseFormatError(f"invalid JSON: {exc}") from exc
    canonicalize_clause(clause)
    return clause


def encode_entry(clause):
    """Encode a validated clause as a log entry (header + payload + CRC32)."""
    payload = canonicalize_clause(clause).encode("utf-8")
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    return _HEADER.pack(len(payload)) + payload + _CRC.pack(crc)


class NogoodLog:
    """Append-only persistent store for nogood clauses."""

    def __init__(self, path):
        self.path = os.fspath(path)

    def append(self, clause):
        """Append one nogood entry.

        The entry is considered committed only after the file buffer is
        flushed and fsync'd.  Raises ClauseFormatError for malformed
        clauses and OSError for I/O failures (e.g. unwritable path).
        """
        entry = encode_entry(clause)
        with open(self.path, "ab") as handle:
            handle.write(entry)
            handle.flush()
            os.fsync(handle.fileno())

    def load(self):
        """Load committed nogoods, stopping at the first bad entry.

        Returns the list of clauses committed before the first truncated
        or checksum-mismatched entry.  Missing or empty logs yield [].
        """
        clauses = []
        try:
            handle = open(self.path, "rb")
        except FileNotFoundError:
            return clauses
        with handle:
            while True:
                header = handle.read(_HEADER.size)
                if len(header) == 0:
                    break  # clean end of log
                if len(header) < _HEADER.size:
                    break  # truncated length header
                (length,) = _HEADER.unpack(header)
                payload = handle.read(length)
                if len(payload) < length:
                    break  # truncated payload
                crc_bytes = handle.read(_CRC.size)
                if len(crc_bytes) < _CRC.size:
                    break  # truncated checksum
                (expected_crc,) = _CRC.unpack(crc_bytes)
                if zlib.crc32(payload) & 0xFFFFFFFF != expected_crc:
                    break  # checksum mismatch
                clauses.append(json.loads(payload.decode("utf-8")))
        return clauses
