#!/usr/bin/env python3
"""bitsetix: map terms to docid sets, evaluate and/or/andnot, save/load.

Storage model
-------------
Docids live in 0..N-1 where N is fixed by the `maxdoc` command.
Each term is held in memory as a Python set, but is serialized either as a
sorted list of uint32 docids (sparse) or as a bitmap of 65536-bit blocks
(dense).  The encoding is chosen per term at save time by whichever is
smaller; after load the two encodings are externally indistinguishable.

File format (all integers little endian)::

    magic      4 bytes  b"BTSX"
    version    uint32   (=1)
    maxdoc     uint64   N
    nterms     uint32
    per term:
        name_len   uint16
        name       name_len bytes (utf-8)
        encoding   uint8   0=sorted list, 1=bitmap
        payload    list:   uint32 count, count*uint32 docids (sorted)
                   bitmap: uint64 nbytes, nbytes bytes (ceil(N/8))
        crc32      uint32  zlib.crc32 over name_len..payload

Exit codes: 0 ok, 1 generic usage error, 2 docid out of range,
3 expression parse error, 4 file validation (version/CRC/structure) failure.
"""
from __future__ import annotations

import struct
import sys
import zlib

MAGIC = b"BTSX"
VERSION = 1
BLOCK_BITS = 65536

ENC_LIST = 0
ENC_BITMAP = 1

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_RANGE = 2
EXIT_EXPR = 3
EXIT_CORRUPT = 4


class DocidRangeError(Exception):
    """add with a docid outside 0..N-1."""


class ExprError(Exception):
    """expression parse error (bad parentheses, unexpected token, ...)."""


class CorruptFileError(Exception):
    """save-file failed validation (magic/version/structure/CRC)."""


# --------------------------------------------------------------------------
# expression parsing / evaluation
# --------------------------------------------------------------------------

_OPERATORS = ("and", "or", "andnot")


def _tokenize(expr: str) -> list[str]:
    tokens: list[str] = []
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch.isspace():
            i += 1
        elif ch in "()":
            tokens.append(ch)
            i += 1
        else:
            j = i
            while j < len(expr) and not expr[j].isspace() and expr[j] not in "()":
                j += 1
            tokens.append(expr[i:j])
            i = j
    return tokens


class _Parser:
    """expr := or_expr
    or_expr  := and_expr ('or' and_expr)*
    and_expr := atom (('and'|'andnot') atom)*   (left associative)
    atom     := '(' expr ')' | TERM
    """

    def __init__(self, tokens: list[str], lookup):
        self.tokens = tokens
        self.pos = 0
        self.lookup = lookup

    def parse(self) -> set[int]:
        if not self.tokens:
            raise ExprError("empty expression")
        result = self._or_expr()
        if self.pos != len(self.tokens):
            raise ExprError(f"unexpected token: {self.tokens[self.pos]!r}")
        return result

    def _peek(self) -> str | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def _or_expr(self) -> set[int]:
        result = self._and_expr()
        while self._peek() == "or":
            self.pos += 1
            result = result | self._and_expr()
        return result

    def _and_expr(self) -> set[int]:
        result = self._atom()
        while self._peek() in ("and", "andnot"):
            op = self.tokens[self.pos]
            self.pos += 1
            rhs = self._atom()
            result = result & rhs if op == "and" else result - rhs
        return result

    def _atom(self) -> set[int]:
        tok = self._peek()
        if tok is None:
            raise ExprError("unexpected end of expression")
        if tok == "(":
            self.pos += 1
            result = self._or_expr()
            if self._peek() != ")":
                raise ExprError("missing closing parenthesis")
            self.pos += 1
            return result
        if tok == ")" or tok in _OPERATORS:
            raise ExprError(f"unexpected token: {tok!r}")
        self.pos += 1
        return set(self.lookup(tok))


# --------------------------------------------------------------------------
# core container
# --------------------------------------------------------------------------


class Bitsetix:
    def __init__(self) -> None:
        self.maxdoc: int | None = None
        self.terms: dict[str, set[int]] = {}

    # -- mutation ----------------------------------------------------------

    def set_maxdoc(self, n: int) -> None:
        if n <= 0:
            raise ValueError("maxdoc must be positive")
        self.maxdoc = n

    def add(self, term: str, docids) -> None:
        if self.maxdoc is None:
            raise DocidRangeError("maxdoc not set")
        bucket = self.terms.setdefault(term, set())
        for d in docids:
            if not 0 <= d < self.maxdoc:
                raise DocidRangeError(
                    f"docid {d} out of range 0..{self.maxdoc - 1}"
                )
            bucket.add(d)

    # -- query -------------------------------------------------------------

    def get(self, term: str) -> set[int]:
        """Unknown terms behave as the empty set."""
        return self.terms.get(term, set())

    def evaluate(self, expr: str) -> set[int]:
        return _Parser(_tokenize(expr), self.get).parse()

    # -- serialization -----------------------------------------------------

    def _encode_term(self, docs: set[int]) -> tuple[int, bytes]:
        """Pick the smaller of sorted-list / 65536-block bitmap encoding."""
        list_payload = struct.pack("<I", len(docs)) + b"".join(
            struct.pack("<I", d) for d in sorted(docs)
        )
        nbytes = (self.maxdoc + 7) // 8
        bitmap = bytearray(nbytes)
        for d in docs:
            bitmap[d >> 3] |= 1 << (d & 7)
        bitmap_payload = struct.pack("<Q", nbytes) + bytes(bitmap)
        if len(list_payload) <= len(bitmap_payload):
            return ENC_LIST, list_payload
        return ENC_BITMAP, bitmap_payload

    def save(self, path: str) -> None:
        if self.maxdoc is None:
            raise ValueError("maxdoc not set")
        out = bytearray()
        out += MAGIC
        out += struct.pack("<I", VERSION)
        out += struct.pack("<Q", self.maxdoc)
        out += struct.pack("<I", len(self.terms))
        for name in sorted(self.terms):
            name_bytes = name.encode("utf-8")
            if len(name_bytes) > 0xFFFF:
                raise ValueError(f"term name too long: {name!r}")
            encoding, payload = self._encode_term(self.terms[name])
            record = struct.pack("<H", len(name_bytes)) + name_bytes
            record += struct.pack("<B", encoding) + payload
            record += struct.pack("<I", zlib.crc32(record) & 0xFFFFFFFF)
            out += record
        with open(path, "wb") as fh:
            fh.write(bytes(out))

    def load(self, path: str) -> None:
        """Replace contents from file.  On any validation failure raise
        CorruptFileError; the file itself is never modified."""
        with open(path, "rb") as fh:
            data = fh.read()
        maxdoc, terms = self._decode(data)  # fully validate before commit
        self.maxdoc = maxdoc
        self.terms = terms

    @staticmethod
    def _decode(data: bytes) -> tuple[int, dict[str, set[int]]]:
        def fail(msg: str):
            raise CorruptFileError(msg)

        pos = 0

        def take(n: int, what: str) -> bytes:
            nonlocal pos
            if pos + n > len(data):
                fail(f"truncated file while reading {what}")
            chunk = data[pos : pos + n]
            pos += n
            return chunk

        def unpack(fmt: str, what: str):
            return struct.unpack(fmt, take(struct.calcsize(fmt), what))[0]

        if take(4, "magic") != MAGIC:
            fail("bad magic")
        if unpack("<I", "version") != VERSION:
            fail("unsupported version")
        maxdoc = unpack("<Q", "maxdoc")
        if maxdoc <= 0:
            fail("invalid maxdoc")
        nterms = unpack("<I", "term count")
        terms: dict[str, set[int]] = {}
        for _ in range(nterms):
            crc_start = pos
            name_len = unpack("<H", "term name length")
            name = take(name_len, "term name").decode("utf-8", "strict")
            encoding = unpack("<B", "encoding")
            docs: set[int] = set()
            if encoding == ENC_LIST:
                count = unpack("<I", "docid count")
                prev = -1
                for _ in range(count):
                    d = unpack("<I", "docid")
                    if not 0 <= d < maxdoc:
                        fail(f"docid {d} out of range in file")
                    if d <= prev:
                        fail("docid list not strictly sorted")
                    prev = d
                    docs.add(d)
            elif encoding == ENC_BITMAP:
                nbytes = unpack("<Q", "bitmap length")
                if nbytes != (maxdoc + 7) // 8:
                    fail("bitmap length does not match maxdoc")
                raw = take(nbytes, "bitmap")
                for i, byte in enumerate(raw):
                    while byte:
                        bit = (byte & -byte).bit_length() - 1
                        docs.add(i * 8 + bit)
                        byte &= byte - 1
                docs = {d for d in docs if d < maxdoc}
            else:
                fail(f"unknown encoding {encoding}")
            crc_end = pos
            expected = unpack("<I", "crc32")
            actual = zlib.crc32(data[crc_start:crc_end]) & 0xFFFFFFFF
            if actual != expected:
                fail(f"CRC mismatch for term {name!r}")
            terms[name] = docs
        if pos != len(data):
            fail("trailing bytes after last term")
        return maxdoc, terms


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def run_cli(stream, out) -> int:
    bx = Bitsetix()
    for lineno, raw in enumerate(stream, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        cmd, rest = parts[0], (parts[1] if len(parts) > 1 else "")
        try:
            if cmd == "maxdoc":
                bx.set_maxdoc(int(rest))
            elif cmd == "add":
                fields = rest.split()
                if not fields:
                    raise ValueError("add requires a term")
                bx.add(fields[0], [int(x) for x in fields[1:]])
            elif cmd == "query":
                result = sorted(bx.evaluate(rest))
                print(" ".join(map(str, result)), file=out)
            elif cmd == "save":
                bx.save(rest.strip())
            elif cmd == "load":
                bx.load(rest.strip())
            else:
                print(f"line {lineno}: unknown command {cmd!r}", file=sys.stderr)
                return EXIT_USAGE
        except DocidRangeError as exc:
            print(f"line {lineno}: {exc}", file=sys.stderr)
            return EXIT_RANGE
        except ExprError as exc:
            print(f"line {lineno}: expression error: {exc}", file=sys.stderr)
            return EXIT_EXPR
        except CorruptFileError as exc:
            print(f"line {lineno}: corrupt file: {exc}", file=sys.stderr)
            return EXIT_CORRUPT
        except (ValueError, OSError) as exc:
            print(f"line {lineno}: {exc}", file=sys.stderr)
            return EXIT_USAGE
    return EXIT_OK


def main(argv: list[str]) -> int:
    if len(argv) > 1:
        with open(argv[1], "r", encoding="utf-8") as fh:
            return run_cli(fh, sys.stdout)
    return run_cli(sys.stdin, sys.stdout)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
