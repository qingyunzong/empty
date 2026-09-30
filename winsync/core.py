"""Core sliding-window pull engine for winsync.

Segment format (binary, per .seg file):
    repeated records of  [crc32:u32be][length:u32be][payload bytes]
crc32 is zlib.crc32(payload) & 0xFFFFFFFF.

Records are assigned a global monotonically increasing ``seq`` across all
``.seg`` files of the source directory in sorted filename order.

Commit protocol (crash safe):
    1. append record to DST (JSONL), flush + fsync
    2. persist ACK file (atomic tmp + replace)
Recovery takes ``max(ack.high_watermark, dst.max_seq + 1)`` so a crash
between step 1 and 2 never produces duplicates in DST.
"""

from __future__ import annotations

import base64
import json
import os
import struct
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

RECORD_HEADER = struct.Struct(">II")  # (crc32, payload_length)
SEG_SUFFIX = ".seg"


class WinsyncError(Exception):
    """User-facing error (reported on stderr by the CLI)."""


@dataclass
class Record:
    seq: int
    segment: str
    expected_crc: int
    payload: bytes
    format_ok: bool = True


def verify(record: Record) -> bool:
    """Check a record's CRC. Safe to run concurrently."""
    if not record.format_ok:
        return False
    return (zlib.crc32(record.payload) & 0xFFFFFFFF) == record.expected_crc


def list_segments(src: str) -> list[str]:
    if not os.path.isdir(src):
        raise WinsyncError(f"source directory not found: {src}")
    return sorted(n for n in os.listdir(src) if n.endswith(SEG_SUFFIX))


def iter_records(src: str):
    """Yield Record objects with global seqs across sorted .seg files."""
    seq = 0
    for name in list_segments(src):
        path = os.path.join(src, name)
        with open(path, "rb") as fh:
            data = fh.read()
        offset = 0
        while offset < len(data):
            if offset + RECORD_HEADER.size > len(data):
                yield Record(seq, name, 0, b"", format_ok=False)
                seq += 1
                break
            crc, length = RECORD_HEADER.unpack_from(data, offset)
            offset += RECORD_HEADER.size
            if offset + length > len(data):
                yield Record(seq, name, crc, data[offset:], format_ok=False)
                seq += 1
                break
            yield Record(seq, name, crc, data[offset:offset + length])
            offset += length
            seq += 1


def load_state(ack_path: str) -> dict:
    if not os.path.exists(ack_path):
        return {"high_watermark": 0, "quarantined": []}
    try:
        with open(ack_path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
        hw = int(state.get("high_watermark", 0))
        quarantined = list(state.get("quarantined", []))
    except (ValueError, TypeError, KeyError) as exc:
        raise WinsyncError(f"corrupt ACK file {ack_path}: {exc}") from exc
    if hw < 0:
        raise WinsyncError(f"corrupt ACK file {ack_path}: negative watermark")
    return {"high_watermark": hw, "quarantined": quarantined}


def save_state(ack_path: str, high_watermark: int, quarantined: list[str]) -> None:
    tmp = ack_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"high_watermark": high_watermark, "quarantined": quarantined}, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, ack_path)


def dst_watermark(dst_path: str) -> int:
    """Highest committed seq + 1 found in DST, or 0 if absent/empty."""
    if not os.path.exists(dst_path):
        return 0
    max_seq = -1
    with open(dst_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                seq = int(entry["seq"])
            except (ValueError, TypeError, KeyError) as exc:
                raise WinsyncError(f"corrupt DST file {dst_path}: {exc}") from exc
            max_seq = max(max_seq, seq)
    return max_seq + 1


def _payload_fields(payload: bytes) -> dict:
    try:
        return {"payload": payload.decode("utf-8")}
    except UnicodeDecodeError:
        return {"payload_b64": base64.b64encode(payload).decode("ascii")}


def _format_entry(record: Record) -> str:
    entry = {"seq": record.seq, "segment": record.segment}
    entry.update(_payload_fields(record.payload))
    return json.dumps(entry, ensure_ascii=False)


def pull(src: str, dst: str, ack: str, window: int = 8, crash_hook=None) -> dict:
    """Pull records from SRC into DST with a sliding verification window.

    Verification of up to ``window`` records runs concurrently, but the
    commit watermark only advances contiguously. On the first CRC failure
    the offending segment is quarantined and no further records commit;
    already-committed records are kept.

    ``crash_hook`` (testing only) is invoked after each DST write is
    flushed and before the ACK file is updated.
    """
    window = max(1, int(window))
    state = load_state(ack)
    quarantined: list[str] = list(state["quarantined"])
    quarantined_set = set(quarantined)
    # Duplicate/stale ACKs can never move the watermark backwards, and a
    # crash between DST write and ACK write is healed by taking the max.
    high_watermark = max(state["high_watermark"], dst_watermark(dst))
    if high_watermark != state["high_watermark"] or not os.path.exists(ack):
        save_state(ack, high_watermark, quarantined)

    dst_dir = os.path.dirname(os.path.abspath(dst))
    os.makedirs(dst_dir, exist_ok=True)
    ack_dir = os.path.dirname(os.path.abspath(ack))
    os.makedirs(ack_dir, exist_ok=True)

    records = iter_records(src)
    inflight: dict[int, tuple[Record, object]] = {}
    exhausted = False
    stopped = False
    dst_fh = None
    try:
        with ThreadPoolExecutor(max_workers=window) as pool:
            while True:
                while not stopped and not exhausted and len(inflight) < window:
                    record = next(records, None)
                    if record is None:
                        exhausted = True
                        break
                    if record.segment in quarantined_set:
                        stopped = True
                        break
                    if record.seq < high_watermark:
                        continue  # already committed in a previous run
                    inflight[record.seq] = (record, pool.submit(verify, record))
                if stopped:
                    break
                pending = inflight.pop(high_watermark, None)
                if pending is None:
                    break
                record, future = pending
                if not future.result():
                    if record.segment not in quarantined_set:
                        quarantined.append(record.segment)
                        quarantined_set.add(record.segment)
                    save_state(ack, high_watermark, quarantined)
                    break
                if dst_fh is None:
                    dst_fh = open(dst, "a", encoding="utf-8")
                dst_fh.write(_format_entry(record) + "\n")
                dst_fh.flush()
                os.fsync(dst_fh.fileno())
                if crash_hook is not None:
                    crash_hook()
                high_watermark = record.seq + 1
                save_state(ack, high_watermark, quarantined)
    finally:
        if dst_fh is not None:
            dst_fh.close()

    return {"high_watermark": high_watermark, "quarantined": quarantined}
