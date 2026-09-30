#!/usr/bin/env python3
"""pcomp: compressed posting-list index.

Builds a custom binary index from {term: [docid, ...]}, looks up docids
by term without decompressing the whole index, and verifies integrity.

Binary layout (all integers little-endian)::

    Header (24 bytes)
      magic        8 bytes   b"PCOMPIDX"
      version      uint32    1
      dict_offset  uint64    absolute offset of the term dictionary
      header_crc   uint32    CRC32 of the preceding 20 bytes

    Postings region [24, dict_offset)
      For each term, a sequence of blocks. Each block:
        count        uint8     number of docids in this block (1..128;
                               a short final block is marked by count < 128)
        payload_len  uint32    byte length of payload
        payload      bytes     `count` LEB128 varints: first docid as-is,
                               then gaps (docid[i] - docid[i-1])
        block_crc    uint32    CRC32 of count||payload_len||payload

    Term dictionary at dict_offset
      term_count   uint32
      per term (sorted by term bytes):
        term_len     uint16
        term         bytes (UTF-8)
        offset       uint64   absolute offset of the term's first block
        length       uint64   byte length of the term's posting data
        doc_count    uint32   total number of docids for the term
      dict_crc     uint32     CRC32 of all dictionary bytes before it

Exit codes: 0 success (missing term -> empty output, still 0),
2 usage/IO error, 4 any corruption (bad magic, CRC mismatch, or any
length/offset out of bounds). Corruption never yields partial results.
"""

import argparse
import os
import struct
import sys
import zlib

MAGIC = b"PCOMPIDX"
VERSION = 1
BLOCK_SIZE = 128
MAX_DOCID = 0xFFFFFFFF

HEADER_FMT = "<8sIQI"
HEADER_LEN = struct.calcsize(HEADER_FMT)  # 24
BLOCK_HEADER_FMT = "<BI"
BLOCK_HEADER_LEN = struct.calcsize(BLOCK_HEADER_FMT)  # 5
DICT_COUNT_FMT = "<I"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CORRUPT = 4


class Corrupt(Exception):
    """Raised on any integrity violation in the index file."""


# ---------------------------------------------------------------- varints

def encode_varint(value):
    if value < 0:
        raise ValueError("varint cannot encode negative values")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def decode_varints(buf, expected_count):
    """Decode exactly `expected_count` LEB128 varints from buf."""
    values = []
    pos = 0
    n = len(buf)
    for _ in range(expected_count):
        shift = 0
        value = 0
        while True:
            if pos >= n:
                raise Corrupt("truncated varint in block payload")
            byte = buf[pos]
            pos += 1
            value |= (byte & 0x7F) << shift
            if not (byte & 0x80):
                break
            shift += 7
            if shift > 63:
                raise Corrupt("varint too long in block payload")
        values.append(value)
    if pos != n:
        raise Corrupt("trailing bytes in block payload")
    return values


# ---------------------------------------------------------------- encoding

def encode_postings(docids):
    """Encode a sorted, deduplicated docid list into blocks."""
    out = bytearray()
    for start in range(0, len(docids), BLOCK_SIZE):
        chunk = docids[start:start + BLOCK_SIZE]
        payload = bytearray()
        prev = 0
        for i, docid in enumerate(chunk):
            gap = docid if i == 0 else docid - prev
            payload += encode_varint(gap)
            prev = docid
        count = len(chunk)
        header = struct.pack(BLOCK_HEADER_FMT, count, len(payload))
        crc = zlib.crc32(header + payload) & 0xFFFFFFFF
        out += header
        out += payload
        out += struct.pack("<I", crc)
    return bytes(out)


def decode_postings(buf, expected_docs):
    """Decode and fully verify one term's posting bytes -> list of docids."""
    docids = []
    pos = 0
    n = len(buf)
    while pos < n:
        if pos + BLOCK_HEADER_LEN > n:
            raise Corrupt("truncated block header")
        count, payload_len = struct.unpack_from(BLOCK_HEADER_FMT, buf, pos)
        if count < 1 or count > BLOCK_SIZE:
            raise Corrupt("invalid block count %d" % count)
        block_end = pos + BLOCK_HEADER_LEN + payload_len + 4
        if block_end > n:
            raise Corrupt("block payload length out of bounds")
        payload = buf[pos + BLOCK_HEADER_LEN:pos + BLOCK_HEADER_LEN + payload_len]
        (stored_crc,) = struct.unpack_from(
            "<I", buf, pos + BLOCK_HEADER_LEN + payload_len)
        actual_crc = zlib.crc32(
            buf[pos:pos + BLOCK_HEADER_LEN + payload_len]) & 0xFFFFFFFF
        if stored_crc != actual_crc:
            raise Corrupt("block CRC mismatch")
        gaps = decode_varints(payload, count)
        for i, gap in enumerate(gaps):
            if i == 0:
                docid = gap
            else:
                docid = docids[-1] + gap
                if docid <= docids[-1]:
                    raise Corrupt("docids not strictly increasing")
            if docid > MAX_DOCID:
                raise Corrupt("docid out of range")
            docids.append(docid)
        pos = block_end
    if len(docids) != expected_docs:
        raise Corrupt("doc_count mismatch: header says %d, decoded %d"
                      % (expected_docs, len(docids)))
    return docids


# ---------------------------------------------------------------- building

def build_index(terms, out_path):
    """terms: dict[str, iterable[int]] -> write index file."""
    norm = {}
    for term, docids in terms.items():
        term_bytes = term.encode("utf-8")
        if len(term_bytes) > 0xFFFF:
            raise ValueError("term too long: %r" % term)
        cleaned = sorted({int(d) for d in docids})
        for d in cleaned:
            if d < 0 or d > MAX_DOCID:
                raise ValueError("docid out of range: %d" % d)
        if cleaned:
            norm[term_bytes] = cleaned

    postings = bytearray()
    entries = []
    for term_bytes in sorted(norm):
        encoded = encode_postings(norm[term_bytes])
        offset = HEADER_LEN + len(postings)
        postings += encoded
        entries.append((term_bytes, offset, len(encoded), len(norm[term_bytes])))

    dict_offset = HEADER_LEN + len(postings)
    dictionary = bytearray()
    dictionary += struct.pack(DICT_COUNT_FMT, len(entries))
    for term_bytes, offset, length, doc_count in entries:
        dictionary += struct.pack("<H", len(term_bytes))
        dictionary += term_bytes
        dictionary += struct.pack("<QQI", offset, length, doc_count)
    dictionary += struct.pack("<I", zlib.crc32(bytes(dictionary)) & 0xFFFFFFFF)

    header = struct.pack(HEADER_FMT, MAGIC, VERSION, dict_offset, 0)
    header = header[:20] + struct.pack("<I", zlib.crc32(header[:20]) & 0xFFFFFFFF)

    with open(out_path, "wb") as fh:
        fh.write(header)
        fh.write(postings)
        fh.write(dictionary)


# ---------------------------------------------------------------- reading

def _read_header(fh, file_size):
    if file_size < HEADER_LEN:
        raise Corrupt("file too small for header")
    fh.seek(0)
    raw = fh.read(HEADER_LEN)
    magic, version, dict_offset, header_crc = struct.unpack(HEADER_FMT, raw)
    if magic != MAGIC:
        raise Corrupt("bad magic")
    if version != VERSION:
        raise Corrupt("unsupported version %d" % version)
    if (zlib.crc32(raw[:20]) & 0xFFFFFFFF) != header_crc:
        raise Corrupt("header CRC mismatch")
    if dict_offset < HEADER_LEN or dict_offset > file_size:
        raise Corrupt("dictionary offset out of bounds")
    return dict_offset


def _read_dictionary(fh, file_size, dict_offset):
    fh.seek(dict_offset)
    raw = fh.read(file_size - dict_offset)
    if len(raw) < 8:
        raise Corrupt("dictionary truncated")
    body = raw[:-4]
    (stored_crc,) = struct.unpack_from("<I", raw, len(raw) - 4)
    if (zlib.crc32(body) & 0xFFFFFFFF) != stored_crc:
        raise Corrupt("dictionary CRC mismatch")
    (term_count,) = struct.unpack_from(DICT_COUNT_FMT, body, 0)
    pos = 4
    entries = {}
    prev_term = None
    for _ in range(term_count):
        if pos + 2 > len(body):
            raise Corrupt("dictionary entry truncated")
        (term_len,) = struct.unpack_from("<H", body, pos)
        pos += 2
        if pos + term_len + 20 > len(body):
            raise Corrupt("dictionary entry out of bounds")
        term = body[pos:pos + term_len]
        pos += term_len
        offset, length, doc_count = struct.unpack_from("<QQI", body, pos)
        pos += 20
        if prev_term is not None and term <= prev_term:
            raise Corrupt("dictionary not sorted")
        prev_term = term
        if (offset < HEADER_LEN or offset + length > dict_offset
                or (length == 0) != (doc_count == 0)):
            raise Corrupt("posting offset/length out of bounds")
        entries[term] = (offset, length, doc_count)
    if pos != len(body):
        raise Corrupt("trailing bytes in dictionary")
    return entries


def _open_and_parse(path):
    file_size = os.path.getsize(path)
    fh = open(path, "rb")
    try:
        dict_offset = _read_header(fh, file_size)
        entries = _read_dictionary(fh, file_size, dict_offset)
    except Exception:
        fh.close()
        raise
    return fh, entries


def lookup(path, term):
    """Return the docid list for term, or [] if absent.

    Only the header, dictionary, and the target term's blocks are read.
    """
    fh, entries = _open_and_parse(path)
    try:
        entry = entries.get(term.encode("utf-8"))
        if entry is None:
            return []
        offset, length, doc_count = entry
        fh.seek(offset)
        buf = fh.read(length)
        if len(buf) != length:
            raise Corrupt("could not read posting data")
        return decode_postings(buf, doc_count)
    finally:
        fh.close()


def scan(path):
    """Fully verify the index. Returns (term_count, total_docids)."""
    fh, entries = _open_and_parse(path)
    try:
        total = 0
        for term, (offset, length, doc_count) in entries.items():
            fh.seek(offset)
            buf = fh.read(length)
            if len(buf) != length:
                raise Corrupt("could not read posting data for %r" % term)
            docids = decode_postings(buf, doc_count)
            total += len(docids)
        return len(entries), total
    finally:
        fh.close()


# ---------------------------------------------------------------- CLI

def _parse_input_line(line, lineno):
    parts = line.split()
    if not parts:
        return None
    term = parts[0]
    docids = []
    for tok in parts[1:]:
        try:
            docids.append(int(tok))
        except ValueError:
            raise ValueError("line %d: bad docid %r" % (lineno, tok))
    return term, docids


def cmd_build(args):
    terms = {}
    with open(args.input, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            parsed = _parse_input_line(line, lineno)
            if parsed is None:
                continue
            term, docids = parsed
            terms.setdefault(term, []).extend(docids)
    build_index(terms, args.output)
    size = os.path.getsize(args.output)
    print("built %s: %d terms, %d bytes" % (args.output, len(terms), size))
    return EXIT_OK


def cmd_lookup(args):
    docids = lookup(args.index, args.term)
    if docids:
        print(" ".join(str(d) for d in docids))
    return EXIT_OK


def cmd_scan(args):
    term_count, total = scan(args.index)
    print("OK: %d terms, %d docids" % (term_count, total))
    return EXIT_OK


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="pcomp", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser("build", help="build an index from a text file")
    p_build.add_argument("input", help="text file: 'term docid docid ...' per line")
    p_build.add_argument("output", help="output index path")
    p_build.set_defaults(func=cmd_build)

    p_lookup = sub.add_parser("lookup", help="print docids for a term")
    p_lookup.add_argument("index")
    p_lookup.add_argument("term")
    p_lookup.set_defaults(func=cmd_lookup)

    p_scan = sub.add_parser("scan", help="verify the whole index")
    p_scan.add_argument("index")
    p_scan.set_defaults(func=cmd_scan)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Corrupt as exc:
        print("Corrupt: %s" % exc, file=sys.stderr)
        return EXIT_CORRUPT
    except (OSError, ValueError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
