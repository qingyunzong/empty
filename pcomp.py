#!/usr/bin/env python3
"""pcomp: compressed postings index builder/querier.

Binary format (all integers little-endian):
  [0:4]    magic b"PCMP"
  [4:8]    version u32 (=1)
  [8:16]   dict_offset u64
  [16:20]  crc32 u32 over bytes [20:EOF]
  [20:dict_offset]            postings region
  [dict_offset:EOF]           term dictionary

Postings per term: sequence of blocks, each block holds up to 128 docids.
  block := count u8 (1..128), first_docid varint, then (count-1) gap varints
  gaps are strictly positive (docids strictly increasing within a term).
  The final block may be short; its true length is the stored count.

Dictionary:
  num_terms u32, then per term (sorted by term bytes):
    term_len u16, term bytes (utf-8), offset u64, length u64, num_docs u32
"""

import struct
import sys
import zlib

MAGIC = b"PCMP"
VERSION = 1
HEADER_SIZE = 20
BLOCK_SIZE = 128
MAX_DOCID = 2**32 - 1
EXIT_CORRUPT = 4


class Corrupt(Exception):
    pass


# ---------- varint (unsigned LEB128) ----------

def write_varint(buf, value):
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            buf.append(byte | 0x80)
        else:
            buf.append(byte)
            return


def read_varint(data, pos, end):
    result = 0
    shift = 0
    while True:
        if pos >= end:
            raise Corrupt("varint overruns buffer")
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result, pos
        shift += 7
        if shift > 63:
            raise Corrupt("varint too long")


# ---------- postings encode/decode ----------

def encode_postings(docids):
    """docids must be sorted, deduped, within [0, 2^32-1]."""
    buf = bytearray()
    for start in range(0, len(docids), BLOCK_SIZE):
        block = docids[start:start + BLOCK_SIZE]
        buf.append(len(block))
        write_varint(buf, block[0])
        prev = block[0]
        for docid in block[1:]:
            write_varint(buf, docid - prev)
            prev = docid
    return bytes(buf)


def decode_postings(data, num_docs):
    """Strictly decode a postings byte string; raise Corrupt on any anomaly."""
    docids = []
    pos = 0
    end = len(data)
    prev = -1
    while pos < end:
        count = data[pos]
        pos += 1
        if count < 1 or count > BLOCK_SIZE:
            raise Corrupt("invalid block count %d" % count)
        first, pos = read_varint(data, pos, end)
        if first > MAX_DOCID:
            raise Corrupt("docid out of range")
        if first <= prev:
            raise Corrupt("docids not strictly increasing")
        docids.append(first)
        prev = first
        for _ in range(count - 1):
            gap, pos = read_varint(data, pos, end)
            if gap < 1:
                raise Corrupt("non-positive gap")
            docid = prev + gap
            if docid > MAX_DOCID:
                raise Corrupt("docid out of range")
            docids.append(docid)
            prev = docid
    if len(docids) != num_docs:
        raise Corrupt("doc count mismatch: header=%d decoded=%d" % (num_docs, len(docids)))
    return docids


# ---------- build ----------

def normalize(docids):
    """Sort and dedupe; validate range."""
    out = sorted(set(docids))
    for docid in out:
        if not isinstance(docid, int) or docid < 0 or docid > MAX_DOCID:
            raise ValueError("docid out of range: %r" % (docid,))
    return out


def build_bytes(terms):
    """terms: dict term(str) -> iterable of docids. Returns index bytes."""
    postings = bytearray()
    entries = []
    for term in sorted(terms):
        docids = normalize(terms[term])
        blob = encode_postings(docids)
        offset = HEADER_SIZE + len(postings)
        postings += blob
        entries.append((term.encode("utf-8"), offset, len(blob), len(docids)))

    dict_offset = HEADER_SIZE + len(postings)
    dictionary = bytearray()
    dictionary += struct.pack("<I", len(entries))
    for term_bytes, offset, length, num_docs in entries:
        if len(term_bytes) > 0xFFFF:
            raise ValueError("term too long")
        dictionary += struct.pack("<H", len(term_bytes))
        dictionary += term_bytes
        dictionary += struct.pack("<QQI", offset, length, num_docs)

    body = bytes(postings) + bytes(dictionary)
    crc = zlib.crc32(body) & 0xFFFFFFFF
    header = MAGIC + struct.pack("<IQI", VERSION, dict_offset, crc)
    return header + body


# ---------- read side ----------

def _parse_header(data):
    if len(data) < HEADER_SIZE:
        raise Corrupt("file shorter than header")
    if data[0:4] != MAGIC:
        raise Corrupt("bad magic")
    version, dict_offset, crc = struct.unpack("<IQI", data[4:HEADER_SIZE])
    if version != VERSION:
        raise Corrupt("unsupported version %d" % version)
    if dict_offset < HEADER_SIZE or dict_offset > len(data):
        raise Corrupt("dict offset out of bounds")
    if (zlib.crc32(data[HEADER_SIZE:]) & 0xFFFFFFFF) != crc:
        raise Corrupt("CRC32 mismatch")
    return dict_offset


def _parse_dict(data, dict_offset):
    dictionary = {}
    pos = dict_offset
    end = len(data)
    if pos + 4 > end:
        raise Corrupt("dict truncated")
    (num_terms,) = struct.unpack_from("<I", data, pos)
    pos += 4
    prev_term = None
    for _ in range(num_terms):
        if pos + 2 > end:
            raise Corrupt("dict truncated")
        (term_len,) = struct.unpack_from("<H", data, pos)
        pos += 2
        if pos + term_len + 20 > end:
            raise Corrupt("dict entry out of bounds")
        term_bytes = bytes(data[pos:pos + term_len])
        pos += term_len
        offset, length, num_docs = struct.unpack_from("<QQI", data, pos)
        pos += 20
        if prev_term is not None and term_bytes <= prev_term:
            raise Corrupt("dictionary not sorted")
        prev_term = term_bytes
        if offset < HEADER_SIZE or offset + length > dict_offset:
            raise Corrupt("postings region out of bounds")
        try:
            term = term_bytes.decode("utf-8")
        except UnicodeDecodeError:
            raise Corrupt("term is not valid utf-8")
        dictionary[term] = (offset, length, num_docs)
    if pos != end:
        raise Corrupt("trailing bytes after dictionary")
    return dictionary


def load_dictionary(path):
    with open(path, "rb") as fh:
        data = fh.read()
    dict_offset = _parse_header(data)
    return data, dict_offset, _parse_dict(data, dict_offset)


def lookup(path, term):
    """Return list of docids for term, or [] if absent. Raises Corrupt."""
    data, _dict_offset, dictionary = load_dictionary(path)
    entry = dictionary.get(term)
    if entry is None:
        return []
    offset, length, num_docs = entry
    blob = data[offset:offset + length]
    if len(blob) != length:
        raise Corrupt("postings truncated")
    return decode_postings(blob, num_docs)


def scan(path):
    """Fully verify the index. Returns (num_terms, total_docs). Raises Corrupt."""
    data, _dict_offset, dictionary = load_dictionary(path)
    total = 0
    for term, (offset, length, num_docs) in dictionary.items():
        blob = data[offset:offset + length]
        if len(blob) != length:
            raise Corrupt("postings truncated")
        docids = decode_postings(blob, num_docs)
        total += len(docids)
    return len(dictionary), total


# ---------- input parsing ----------

def parse_input(path):
    """Each line: term docid [docid ...]. Terms have no whitespace."""
    terms = {}
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            parts = line.split()
            if not parts:
                continue
            term = parts[0]
            try:
                docids = [int(tok, 10) for tok in parts[1:]]
            except ValueError:
                raise ValueError("line %d: bad docid" % lineno)
            terms.setdefault(term, []).extend(docids)
    return terms


# ---------- CLI ----------

def _die_corrupt(exc):
    print("Corrupt: %s" % exc, file=sys.stderr)
    sys.exit(EXIT_CORRUPT)


def main(argv):
    if len(argv) < 2:
        print("usage: pcomp.py build <input.txt> <index> | "
              "lookup <index> <term> | scan <index>", file=sys.stderr)
        return 2
    cmd = argv[1]
    try:
        if cmd == "build":
            if len(argv) != 4:
                print("usage: pcomp.py build <input.txt> <index>", file=sys.stderr)
                return 2
            terms = parse_input(argv[2])
            blob = build_bytes(terms)
            with open(argv[3], "wb") as fh:
                fh.write(blob)
            print("built %s: terms=%d bytes=%d" % (argv[3], len(terms), len(blob)))
            return 0
        if cmd == "lookup":
            if len(argv) != 4:
                print("usage: pcomp.py lookup <index> <term>", file=sys.stderr)
                return 2
            try:
                docids = lookup(argv[2], argv[3])
            except Corrupt as exc:
                _die_corrupt(exc)
            for docid in docids:
                print(docid)
            return 0
        if cmd == "scan":
            if len(argv) != 3:
                print("usage: pcomp.py scan <index>", file=sys.stderr)
                return 2
            try:
                num_terms, total_docs = scan(argv[2])
            except Corrupt as exc:
                _die_corrupt(exc)
            print("OK terms=%d docs=%d" % (num_terms, total_docs))
            return 0
        print("unknown command: %s" % cmd, file=sys.stderr)
        return 2
    except (OSError, ValueError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
