#!/usr/bin/env python3
"""Arbitrary-precision reference checker for BINIDX01 indexes.

Python integers are unbounded, so every boundary computation here is
exact (no 64-bit wraparound). This oracle mirrors the C++ library's
rules and prints the expected machine-readable verdict:

    RESULT: OK
    RESULT: INVALID <CODE>: <message>

Usage: oracle.py <index-file> [--data <data-file>]
"""

import sys

MAGIC = 0x31305844494E4942  # "BINIDX01" little-endian
HEADER = 16
ENTRY = 16
U64_MAX = 2**64 - 1


def read_u64_le(buf, pos):
    return int.from_bytes(buf[pos:pos + 8], "little")


class Invalid(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def parse_index(data):
    if len(data) < 8:
        raise Invalid("TRUNCATED_HEADER", "index shorter than 8-byte magic")
    if read_u64_le(data, 0) != MAGIC:
        raise Invalid("BAD_MAGIC", "bad magic, not a BINIDX01 index")
    if len(data) < HEADER:
        raise Invalid("TRUNCATED_HEADER", "index shorter than 16-byte header")
    count = read_u64_le(data, 8)
    # Arbitrary precision: required is exact, no overflow guard needed.
    required = HEADER + count * ENTRY
    if len(data) < required:
        raise Invalid("TRUNCATED_ENTRIES",
                      f"index truncated: {len(data)} of {required} bytes")
    if len(data) > required:
        raise Invalid("TRAILING_BYTES",
                      f"{len(data) - required} trailing byte(s) after last entry")
    return [(read_u64_le(data, HEADER + i * ENTRY),
             read_u64_le(data, HEADER + i * ENTRY + 8)) for i in range(count)]


def validate_layout(segments):
    ends = []
    for i, (off, length) in enumerate(segments):
        end = off + length  # exact big-int sum
        if end > U64_MAX:
            raise Invalid("SEGMENT_OVERFLOW",
                          f"segment[{i}] offset+length exceeds 2^64-1")
        ends.append(end)
    items = sorted((off, length, i) for i, (off, length) in enumerate(segments))
    anchor = None  # (offset, length, index, end) of widest open segment
    for off, length, i in items:
        if length == 0:
            continue  # empty interval never overlaps
        if anchor is not None and off < anchor[3]:
            if (off, length) != (anchor[0], anchor[1]):
                raise Invalid("PARTIAL_OVERLAP",
                              f"segment[{anchor[2]}] and segment[{i}] partially overlap")
            continue  # identical range: shared, allowed
        anchor = (off, length, i, ends[i])


def validate_against_file(segments, file_size):
    for i, (off, length) in enumerate(segments):
        if off > file_size or length > file_size - off:
            raise Invalid("VIEW_EXCEEDS_FILE",
                          f"segment[{i}] (offset={off}, length={length}) "
                          f"exceeds file size {file_size}")


def expected_result(index_bytes, data_size):
    """Returns (code, message); code is 'OK' when the index is valid."""
    try:
        segments = parse_index(index_bytes)
        validate_layout(segments)
        if data_size is not None:
            validate_against_file(segments, data_size)
    except Invalid as exc:
        return exc.code, exc.message
    return "OK", ""


def main(argv):
    if len(argv) < 2:
        print(f"usage: {argv[0]} <index-file> [--data <data-file>]", file=sys.stderr)
        return 2
    index_path = argv[1]
    data_size = None
    if len(argv) >= 4 and argv[2] == "--data":
        with open(argv[3], "rb") as fh:
            data_size = len(fh.read())
    with open(index_path, "rb") as fh:
        index_bytes = fh.read()
    code, message = expected_result(index_bytes, data_size)
    if code == "OK":
        print("RESULT: OK")
        return 0
    print(f"RESULT: INVALID {code}: {message}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
