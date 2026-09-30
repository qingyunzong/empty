#!/usr/bin/env python3
"""bitsetix: term -> docid-set index with and/or/andnot and save/load.

Storage: each term is encoded on disk either as a sorted docid list or as
65536-bit bitmap blocks, whichever is smaller. After load both encodings
decode to the same in-memory set and are externally indistinguishable.

Exit codes:
    0 ok
    1 usage / unknown command / io error
    2 add with docid out of range [0, maxdoc)
    3 expression syntax error (e.g. bad parentheses)
    4 file validation failure (magic/version/length/CRC)
"""

import os
import re
import struct
import sys
import zlib

MAGIC = b"BSIX"
VERSION = 1
BLOCK_BITS = 65536
BLOCK_BYTES = BLOCK_BITS // 8

ENC_LIST = 1
ENC_BITMAP = 2

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_RANGE = 2
EXIT_SYNTAX = 3
EXIT_CHECKSUM = 4

_U32 = struct.Struct("<I")
_HDR = struct.Struct("<4sIQI")  # magic, version, maxdoc, term_count


class CorruptFileError(Exception):
    """Raised when a saved file fails validation."""


class ExpressionError(Exception):
    """Raised when a query expression is malformed."""


# ---------------------------------------------------------------------------
# Expression parsing / evaluation
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"\s*([A-Za-z0-9_.\-]+|[(),])")


def tokenize(text):
    tokens = []
    pos = 0
    while pos < len(text):
        m = _TOKEN_RE.match(text, pos)
        if not m:
            if text[pos:].strip():
                raise ExpressionError("unexpected character at %d" % pos)
            break
        tokens.append(m.group(1))
        pos = m.end()
    return tokens


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def next(self):
        tok = self.peek()
        self.pos += 1
        return tok

    def expect(self, want):
        got = self.next()
        if got != want:
            raise ExpressionError("expected %r, got %r" % (want, got))

    def parse_expr(self):
        tok = self.next()
        if tok is None:
            raise ExpressionError("unexpected end of expression")
        if tok in ("(", ")", ","):
            raise ExpressionError("unexpected %r" % tok)
        if tok in ("and", "or", "andnot"):
            self.expect("(")
            if self.peek() == ")":
                raise ExpressionError("empty argument list")
            args = [self.parse_expr()]
            while self.peek() == ",":
                self.next()
                args.append(self.parse_expr())
            self.expect(")")
            if tok == "andnot" and len(args) != 2:
                raise ExpressionError("andnot takes exactly 2 arguments")
            return (tok, args)
        return ("term", tok)

    def parse(self):
        tree = self.parse_expr()
        if self.peek() is not None:
            raise ExpressionError("trailing tokens after expression")
        return tree


def parse_expression(text):
    return _Parser(tokenize(text)).parse()


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------

class BitsetIndex:
    def __init__(self):
        self.maxdoc = None
        self.terms = {}  # term -> set of docids

    def set_maxdoc(self, n):
        n = int(n)
        if n <= 0:
            raise ValueError("maxdoc must be positive")
        if self.terms:
            raise ValueError("maxdoc must be set before any add")
        self.maxdoc = n

    def _require_maxdoc(self):
        if self.maxdoc is None:
            raise ValueError("maxdoc not set")

    def add(self, term, docids):
        self._require_maxdoc()
        bucket = self.terms.setdefault(term, set())
        for d in docids:
            d = int(d)
            if d < 0 or d >= self.maxdoc:
                raise IndexError("docid %d out of range [0, %d)" % (d, self.maxdoc))
            bucket.add(d)

    def get(self, term):
        """Unknown terms participate as the empty set."""
        return self.terms.get(term, frozenset())

    def evaluate(self, node):
        kind = node[0]
        if kind == "term":
            return set(self.get(node[1]))
        op, args = node
        if op == "and":
            result = None
            for sub in args:
                value = self.evaluate(sub)
                result = value if result is None else result & value
                if not result:
                    break
            return result if result is not None else set()
        if op == "or":
            result = set()
            for sub in args:
                result |= self.evaluate(sub)
            return result
        if op == "andnot":
            return self.evaluate(args[0]) - self.evaluate(args[1])
        raise ExpressionError("unknown operator %r" % op)

    def query(self, text):
        """Evaluate an expression string; returns a sorted list of docids."""
        return sorted(self.evaluate(parse_expression(text)))

    # -- serialization -----------------------------------------------------

    def _encode_term(self, name):
        docs = sorted(self.terms[name])
        list_payload = _U32.pack(len(docs))
        if docs:
            list_payload += struct.pack("<%dI" % len(docs), *docs)

        blocks = {}
        for d in docs:
            blocks.setdefault(d >> 16, bytearray(BLOCK_BYTES))
        for d in docs:
            blocks[d >> 16][(d & 0xFFFF) >> 3] |= 1 << (d & 7)
        bitmap_payload = _U32.pack(len(blocks))
        for blk in sorted(blocks):
            bitmap_payload += _U32.pack(blk) + bytes(blocks[blk])

        if len(list_payload) <= len(bitmap_payload):
            enc, payload = ENC_LIST, list_payload
        else:
            enc, payload = ENC_BITMAP, bitmap_payload

        name_b = name.encode("utf-8")
        body = struct.pack("<H", len(name_b)) + name_b + bytes([enc]) + payload
        crc = zlib.crc32(body) & 0xFFFFFFFF
        return body + _U32.pack(crc)

    def to_bytes(self):
        self._require_maxdoc()
        out = [_HDR.pack(MAGIC, VERSION, self.maxdoc, len(self.terms))]
        for name in sorted(self.terms):
            out.append(self._encode_term(name))
        return b"".join(out)

    def save(self, path):
        data = self.to_bytes()
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)  # atomic: never leave a half-written file

    # -- deserialization ---------------------------------------------------

    @classmethod
    def from_bytes(cls, data):
        idx = cls()
        reader = _Reader(data)
        magic, version, maxdoc, term_count = reader.read(_HDR)
        if magic != MAGIC:
            raise CorruptFileError("bad magic")
        if version != VERSION:
            raise CorruptFileError("unsupported version %d" % version)
        terms = {}
        for _ in range(term_count):
            body_start = reader.pos
            (name_len,) = reader.read(struct.Struct("<H"))
            name = reader.take(name_len).decode("utf-8", "strict")
            (enc,) = reader.read(struct.Struct("<B"))
            if enc == ENC_LIST:
                (count,) = reader.read(_U32)
                docs = set()
                for _ in range(count):
                    (d,) = reader.read(_U32)
                    docs.add(d)
            elif enc == ENC_BITMAP:
                (block_count,) = reader.read(_U32)
                docs = set()
                for _ in range(block_count):
                    (blk,) = reader.read(_U32)
                    raw = reader.take(BLOCK_BYTES)
                    base = blk << 16
                    n = int.from_bytes(raw, "little")
                    while n:
                        lsb = n & -n
                        docs.add(base + lsb.bit_length() - 1)
                        n ^= lsb
            else:
                raise CorruptFileError("unknown encoding %d" % enc)
            (crc,) = reader.read(_U32)
            body = data[body_start:reader.pos - 4]
            if zlib.crc32(body) & 0xFFFFFFFF != crc:
                raise CorruptFileError("CRC mismatch for term %r" % name)
            if name in terms:
                raise CorruptFileError("duplicate term %r" % name)
            for d in docs:
                if d >= maxdoc:
                    raise CorruptFileError("docid %d out of range" % d)
            terms[name] = docs
        if reader.pos != len(data):
            raise CorruptFileError("trailing bytes")
        # Fully validated: only now commit to the index.
        idx.maxdoc = maxdoc
        idx.terms = terms
        return idx

    @classmethod
    def load(cls, path):
        with open(path, "rb") as fh:
            data = fh.read()
        return cls.from_bytes(data)

    def load_into(self, path):
        other = self.load(path)
        self.maxdoc = other.maxdoc
        self.terms = other.terms


class _Reader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def take(self, n):
        if self.pos + n > len(self.data):
            raise CorruptFileError("unexpected end of file")
        chunk = self.data[self.pos:self.pos + n]
        self.pos += n
        return chunk

    def read(self, fmt):
        return fmt.unpack(self.take(fmt.size))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

USAGE = """commands (one per line, read from stdin or a script file):
  maxdoc N                 fix the docid range to [0, N)
  add TERM D [D ...]       add docids to a term (out of range -> exit 2)
  query EXPR               print sorted docids of EXPR
  and(...) / or(...) / andnot(...)   bare expression == query
  save PATH                write the index
  load PATH                read the index (corrupt -> exit 4, file untouched)
  quit                     exit 0
EXPR := and(E, ...) | or(E, ...) | andnot(E, E) | TERM
unknown terms participate as the empty set; empty results print a blank line.
"""


def _run_line(idx, line):
    parts = line.split(None, 1)
    cmd = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    if cmd == "maxdoc":
        idx.set_maxdoc(int(rest.strip()))
    elif cmd == "add":
        fields = rest.split()
        if not fields:
            raise ValueError("add requires a term")
        idx.add(fields[0], [int(x) for x in fields[1:]])
    elif cmd == "query":
        print(" ".join(str(d) for d in idx.query(rest)))
    elif cmd in ("and", "or", "andnot") or cmd.startswith(("and(", "or(", "andnot(")):
        print(" ".join(str(d) for d in idx.query(line)))
    elif cmd == "save":
        idx.save(rest.strip())
    elif cmd == "load":
        idx.load_into(rest.strip())
    elif cmd in ("quit", "exit"):
        return False
    elif cmd in ("help", "?"):
        sys.stderr.write(USAGE)
    else:
        raise ValueError("unknown command %r" % cmd)
    return True


def run(idx, stream):
    for raw in stream:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if not _run_line(idx, line):
            break
    return EXIT_OK


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    idx = BitsetIndex()
    try:
        if argv:
            with open(argv[0], "r", encoding="utf-8") as fh:
                return run(idx, fh)
        return run(idx, sys.stdin)
    except IndexError as exc:
        sys.stderr.write("range error: %s\n" % exc)
        return EXIT_RANGE
    except ExpressionError as exc:
        sys.stderr.write("expression error: %s\n" % exc)
        return EXIT_SYNTAX
    except CorruptFileError as exc:
        sys.stderr.write("corrupt file: %s\n" % exc)
        return EXIT_CHECKSUM
    except (ValueError, OSError) as exc:
        sys.stderr.write("error: %s\n" % exc)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
