"""Append-only Nogood log with CRC32 integrity and crash recovery.

On-disk entry format (all integers big-endian, unsigned):

    +-------------------+-------------------------+------------------+
    | payload_len (4B)  | JSON payload (N bytes)  | CRC32 of payload |
    +-------------------+-------------------------+------------------+
                                              (4B)

Commit semantics: an entry is considered committed only after the full
record (header + payload + checksum) has been written, flushed and
fsync'ed to disk.

Defined failure points:
  a) Crash mid-write -> truncated tail entry (incomplete header,
     payload or checksum).
  b) Checksum mismatch -> payload corrupted after commit.

Recovery semantics: the log is parsed sequentially; the first corrupt
or incomplete entry stops the scan immediately. Only the committed,
valid prefix of entries is returned. A missing or empty log yields an
empty list.
"""

from __future__ import annotations

import json
import os
import struct
import zlib
from typing import Any

_HEADER = struct.Struct(">I")   # payload length
_CRC = struct.Struct(">I")      # crc32 of payload
MAX_PAYLOAD = 16 * 1024 * 1024  # sanity bound against garbage lengths


class LogWriteError(Exception):
    """Raised when an entry cannot be durably appended to the log."""


class ClauseFormatError(ValueError):
    """Raised when a clause JSON document does not match the schema."""


def validate_clause(clause: Any) -> list:
    """Validate a nogood clause, returning the canonical list-of-pairs form.

    A clause must be a JSON array of 2-element arrays ``[var, value]``
    where ``var`` is a non-empty string and ``value`` is an integer
    (booleans are rejected). Variables must not repeat within a clause.
    """
    if not isinstance(clause, list):
        raise ClauseFormatError("clause must be a JSON array")
    seen = set()
    for lit in clause:
        if not (isinstance(lit, list) and len(lit) == 2):
            raise ClauseFormatError("each literal must be a [var, value] pair")
        var, value = lit
        if not isinstance(var, str) or not var:
            raise ClauseFormatError("literal variable must be a non-empty string")
        if not isinstance(value, int) or isinstance(value, bool):
            raise ClauseFormatError("literal value must be an integer")
        if var in seen:
            raise ClauseFormatError(f"duplicate variable in clause: {var!r}")
        seen.add(var)
    return clause


def parse_clause_text(text: str) -> list:
    """Parse and validate a clause from its JSON text form."""
    try:
        clause = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ClauseFormatError(f"invalid JSON: {exc}") from exc
    return validate_clause(clause)


def encode_entry(clause: list) -> bytes:
    """Serialize one clause into its on-disk record."""
    payload = json.dumps(clause, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    return _HEADER.pack(len(payload)) + payload + _CRC.pack(crc)


def append_clause(log_path: str, clause: list) -> None:
    """Append one clause to the log and fsync before returning.

    Raises ClauseFormatError for invalid clauses and LogWriteError for
    any I/O failure (unwritable path, full disk, fsync failure, ...).
    """
    record = encode_entry(validate_clause(clause))
    try:
        with open(log_path, "ab") as fh:
            fh.write(record)
            fh.flush()
            os.fsync(fh.fileno())
    except OSError as exc:
        raise LogWriteError(f"cannot append to log {log_path!r}: {exc}") from exc


def load_clauses(log_path: str) -> list:
    """Load the committed prefix of clauses from the log.

    Stops at the first truncated or checksum-mismatched entry and
    returns only the valid entries parsed before it. A missing or
    empty log returns an empty list.
    """
    clauses: list = []
    try:
        fh = open(log_path, "rb")
    except FileNotFoundError:
        return clauses
    except OSError as exc:
        raise LogWriteError(f"cannot read log {log_path!r}: {exc}") from exc

    with fh:
        while True:
            header = fh.read(_HEADER.size)
            if len(header) == 0:
                break  # clean end of log
            if len(header) < _HEADER.size:
                break  # failure point (a): truncated header
            (length,) = _HEADER.unpack(header)
            if length > MAX_PAYLOAD:
                break  # implausible length: treat as corruption
            payload = fh.read(length)
            if len(payload) < length:
                break  # failure point (a): truncated payload
            crc_raw = fh.read(_CRC.size)
            if len(crc_raw) < _CRC.size:
                break  # failure point (a): truncated checksum
            (expected_crc,) = _CRC.unpack(crc_raw)
            if (zlib.crc32(payload) & 0xFFFFFFFF) != expected_crc:
                break  # failure point (b): checksum mismatch
            try:
                clause = validate_clause(json.loads(payload.decode("utf-8")))
            except (ValueError, UnicodeDecodeError):
                break  # committed bytes are not a valid clause: corrupt
            clauses.append(clause)
    return clauses
