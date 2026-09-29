"""auditlog: append-only audit log with SHA256 hash chain."""

from .core import (
    AuditLog,
    PolicyError,
    Record,
    ZERO_HASH,
    E_CHAIN,
    E_PAYLOAD,
    apply_payload,
    compute_hash,
    encode_record,
    parse_records,
    recover,
)

__all__ = [
    "AuditLog",
    "PolicyError",
    "Record",
    "ZERO_HASH",
    "E_CHAIN",
    "E_PAYLOAD",
    "apply_payload",
    "compute_hash",
    "encode_record",
    "parse_records",
    "recover",
]
