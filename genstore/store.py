"""genstore: a single-file generational key-value store.

File layout (PAGE_SIZE = 4096):
  page 0..1   header slots (slot = G % 2, crc protected).  The header holds
              the current generation G, the root page number of the index and
              the data-page high-water mark.  Updating the header is a single
              small atomic write; a torn write fails the crc and the other
              slot (previous generation) is used instead.
  page 2..65  journal ("tail region"): redo records followed by at most one
              commit marker.  Fixed location so it is always findable.
  page 66..   data pages: 3-level copy-on-write index (root -> middle ->
              leaf).  The root page number lives in the header.

Transaction protocol:
  1. `txn` appends redo records to the journal (fsync after each).
  2. `commit` appends a commit marker (fsync), applies the redo records to
     the index via copy-on-write (fsync), then atomically updates the header
     with G+1 and the new root (fsync), then clears the journal.
  3. `rollback` clears the journal; it refuses if a commit marker exists,
     because committed generations may never be rolled back.

Fault injection points (the only ones allowed):
  A: while writing a redo record (partial record in the journal)
  B: while writing the commit marker (torn marker, bad crc)
  C: after the commit marker, before the header update
  D: after the header update, before the journal is cleared

Recovery rules:
  A/B: no commit marker and a dirty tail (crash remnant bytes after the
       last valid record) -> discard the journal, G unchanged.  A pending
       transaction whose tail is clean (zeros) is left alone, so the CLI
       may span several processes.
  C:   marker g == G + 1 -> redo the committed transaction and update the
       header exactly once; the result equals a normal commit and G is never
       bumped twice.
  D:   marker g == G     -> already applied, just clear the journal.
"""

from __future__ import annotations

import hashlib
import os
import struct
import zlib

PAGE_SIZE = 4096
MAGIC = b"GENSTOR1"
HEADER_SLOTS = 2
JOURNAL_PAGES = 64
JOURNAL_START = HEADER_SLOTS * PAGE_SIZE
JOURNAL_END = JOURNAL_START + JOURNAL_PAGES * PAGE_SIZE
FIRST_DATA_PAGE = HEADER_SLOTS + JOURNAL_PAGES

HDR_BODY = struct.Struct("<8sQQQ")  # magic, generation G, root page, data pages
HDR_CRC = struct.Struct("<I")
HEADER_SIZE = HDR_BODY.size + HDR_CRC.size

REDO_MAGIC = b"REDO"
COMT_MAGIC = b"COMT"
REDO_HDR = struct.Struct("<4sBHI")  # magic, op, key len, value len
COMT_BODY = struct.Struct("<4sQ")   # magic, new generation

OP_DEL = 0
OP_SET = 1

ROOT_EMPTY = 0  # root page number meaning "empty tree"

LEAF_ENTRY_HDR = struct.Struct("<QHI")  # key hash, key len, value len
INTERNAL_ENTRIES = 256


class StoreError(Exception):
    """Base class for genstore errors."""


class PageCorruptError(StoreError):
    """A data page failed its crc check; carries the offending page number."""

    def __init__(self, page_no: int):
        super().__init__(f"page crc mismatch at page {page_no}")
        self.page_no = page_no


class EmptyStore(StoreError):
    """Root is corrupt and no valid backup header exists: store is empty."""


class SimulatedCrash(Exception):
    """Raised at a fault injection point to simulate power loss."""


# ---------------------------------------------------------------- fault hooks

_fault_point = None
_crash_mode = "raise"  # "raise" -> SimulatedCrash, "exit" -> os._exit(1)


def set_fault(point):
    """Arm a one-shot fault injection point: 'A', 'B', 'C', 'D' or None."""
    global _fault_point
    _fault_point = point


def set_crash_mode(mode):
    global _crash_mode
    _crash_mode = mode


def _fault(point):
    global _fault_point
    if _fault_point == point:
        _fault_point = None
        if _crash_mode == "exit":
            os._exit(1)
        raise SimulatedCrash(f"simulated power failure at fault point {point}")


# --------------------------------------------------------------------- store


class GenStore:
    def __init__(self, path, recover=True):
        self.path = path
        self.recovered_empty = False
        fresh = not os.path.exists(path) or os.path.getsize(path) == 0
        self.fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
        if fresh:
            self._init_empty()
        elif recover:
            self._recover()
        else:
            header = self._best_header()
            if header is None:
                self._init_empty()
                self.recovered_empty = True
            else:
                self.G, self.root, self.data_pages = header
                self._scan_journal()

    def close(self):
        os.close(self.fd)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ------------------------------------------------------------ low level

    def _init_empty(self):
        self.G = 0
        self.root = ROOT_EMPTY
        self.data_pages = 0
        self._write_header(0, ROOT_EMPTY, 0)
        os.pwrite(self.fd, b"\0" * PAGE_SIZE, PAGE_SIZE)  # invalidate slot 1
        os.pwrite(self.fd, b"\0" * (JOURNAL_END - JOURNAL_START), JOURNAL_START)
        os.fsync(self.fd)
        self._journal_end = JOURNAL_START

    # -- headers --

    def _read_header_slot(self, slot):
        raw = os.pread(self.fd, HEADER_SIZE, slot * PAGE_SIZE)
        if len(raw) < HEADER_SIZE:
            return None
        magic, gen, root, data_pages = HDR_BODY.unpack(raw[: HDR_BODY.size])
        (crc,) = HDR_CRC.unpack(raw[HDR_BODY.size :])
        if magic != MAGIC:
            return None
        if zlib.crc32(raw[: HDR_BODY.size]) != crc:
            return None
        return (gen, root, data_pages)

    def _write_header(self, gen, root, data_pages):
        slot = gen % HEADER_SLOTS
        body = HDR_BODY.pack(MAGIC, gen, root, data_pages)
        raw = body + HDR_CRC.pack(zlib.crc32(body))
        os.pwrite(self.fd, raw, slot * PAGE_SIZE)  # single atomic small write
        os.fsync(self.fd)

    def _best_header(self):
        candidates = []
        for slot in range(HEADER_SLOTS):
            header = self._read_header_slot(slot)
            if header is not None:
                candidates.append(header)
        candidates.sort(key=lambda h: -h[0])  # highest generation first
        for gen, root, data_pages in candidates:
            if root == ROOT_EMPTY or self._page_ok(root):
                return (gen, root, data_pages)
        return None

    # -- pages --

    def _read_page(self, page_no):
        raw = os.pread(self.fd, PAGE_SIZE, page_no * PAGE_SIZE)
        if len(raw) < PAGE_SIZE:
            raise PageCorruptError(page_no)
        (crc,) = struct.unpack_from("<I", raw, PAGE_SIZE - 4)
        if zlib.crc32(raw[: PAGE_SIZE - 4]) != crc:
            raise PageCorruptError(page_no)
        return raw

    def _page_ok(self, page_no):
        try:
            self._read_page(page_no)
            return True
        except PageCorruptError:
            return False

    def _write_page(self, page_no, body):
        if len(body) > PAGE_SIZE - 4:
            raise StoreError("page body too large")
        raw = body + b"\0" * (PAGE_SIZE - 4 - len(body))
        raw += struct.pack("<I", zlib.crc32(raw))
        os.pwrite(self.fd, raw, page_no * PAGE_SIZE)

    def _alloc_page(self, body):
        page_no = FIRST_DATA_PAGE + self.data_pages
        self._write_page(page_no, body)
        self.data_pages += 1
        return page_no

    # -- journal (tail region) --

    def _scan_journal(self):
        records = []
        comt = None
        off = JOURNAL_START
        while off < JOURNAL_END:
            magic = os.pread(self.fd, 4, off)
            if len(magic) < 4:
                break
            if magic == REDO_MAGIC:
                hdr = os.pread(self.fd, REDO_HDR.size, off)
                if len(hdr) < REDO_HDR.size:
                    break
                _, op, klen, vlen = REDO_HDR.unpack(hdr)
                body = os.pread(self.fd, klen + vlen + 4, off + REDO_HDR.size)
                if len(body) < klen + vlen + 4:
                    break
                (crc,) = struct.unpack_from("<I", body, klen + vlen)
                if zlib.crc32(hdr + body[: klen + vlen]) != crc:
                    break
                records.append((op, body[:klen], body[klen : klen + vlen]))
                off += REDO_HDR.size + klen + vlen + 4
            elif magic == COMT_MAGIC:
                raw = os.pread(self.fd, COMT_BODY.size + 4, off)
                if len(raw) < COMT_BODY.size + 4:
                    break
                _, gen = COMT_BODY.unpack(raw[: COMT_BODY.size])
                (crc,) = struct.unpack_from("<I", raw, COMT_BODY.size)
                if zlib.crc32(raw[: COMT_BODY.size]) != crc:
                    break
                comt = gen
                off += COMT_BODY.size + 4
                break  # the commit marker is always the last record
            else:
                break
        self._journal_end = off
        return records, comt

    def _append_journal(self, rec):
        if self._journal_end + len(rec) > JOURNAL_END:
            raise StoreError("journal full: transaction too large")
        os.pwrite(self.fd, rec, self._journal_end)
        os.fsync(self.fd)
        self._journal_end += len(rec)

    def _clear_journal(self):
        used = self._journal_end - JOURNAL_START
        if used > 0:
            os.pwrite(self.fd, b"\0" * used, JOURNAL_START)
            os.fsync(self.fd)
        self._journal_end = JOURNAL_START

    def _journal_tail_state(self, start):
        """Inspect the journal after the last valid record.

        Returns (dirty, dirty_end): dirty is True if any non-zero crash
        remnant bytes follow; dirty_end is the end of the non-zero region.
        """
        off = start
        dirty = False
        dirty_end = start
        while off < JOURNAL_END:
            chunk = os.pread(self.fd, min(65536, JOURNAL_END - off), off)
            if not chunk:
                break
            stripped = chunk.rstrip(b"\0")
            if stripped:
                dirty = True
                dirty_end = off + len(stripped)
            off += len(chunk)
        return dirty, dirty_end

    # -- index pages --

    @staticmethod
    def _key_hash(key):
        digest = hashlib.sha1(key).digest()
        return digest[0], digest[1], int.from_bytes(digest[2:10], "little")

    @staticmethod
    def _parse_internal(raw):
        return list(struct.unpack_from("<256Q", raw, 8))

    def _alloc_internal(self, entries):
        body = b"I" + b"\0" * 7 + struct.pack("<256Q", *entries)
        return self._alloc_page(body)

    @staticmethod
    def _parse_leaf(raw):
        (count,) = struct.unpack_from("<I", raw, 4)
        entries = []
        off = 8
        for _ in range(count):
            key_hash, klen, vlen = LEAF_ENTRY_HDR.unpack_from(raw, off)
            off += LEAF_ENTRY_HDR.size
            key = raw[off : off + klen]
            off += klen
            value = raw[off : off + vlen]
            off += vlen
            entries.append((key_hash, key, value))
        return entries

    def _alloc_leaf(self, entries):
        body = b"L" + b"\0" * 3 + struct.pack("<I", len(entries))
        for key_hash, key, value in entries:
            body += LEAF_ENTRY_HDR.pack(key_hash, len(key), len(value))
            body += key + value
        if len(body) > PAGE_SIZE - 4:
            raise StoreError("leaf overflow: too many colliding keys")
        return self._alloc_page(body)

    def _cow_node(self, page_no, level, ops):
        """Copy-on-write update; returns the page number of the new node."""
        if level < 2:
            if page_no:
                entries = self._parse_internal(self._read_page(page_no))
            else:
                entries = [0] * INTERNAL_ENTRIES
            groups = {}
            for op in ops:
                idx = self._key_hash(op[1])[level]
                groups.setdefault(idx, []).append(op)
            for idx, sub_ops in groups.items():
                entries[idx] = self._cow_node(entries[idx], level + 1, sub_ops)
            return self._alloc_internal(entries)
        # leaf level
        entries = self._parse_leaf(self._read_page(page_no)) if page_no else []
        for op, key, value in ops:
            key_hash = self._key_hash(key)[2]
            entries = [e for e in entries if e[1] != key]
            if op == OP_SET:
                entries.append((key_hash, key, value))
        if not entries:
            return ROOT_EMPTY
        return self._alloc_leaf(entries)

    def _cow_apply(self, records):
        return self._cow_node(self.root, 0, records)

    # ------------------------------------------------------------- recovery

    def _recover(self):
        header = self._best_header()
        if header is None:
            # Root corrupt and no valid backup header: the store is empty.
            self._init_empty()
            self.recovered_empty = True
            return
        self.G, self.root, self.data_pages = header
        records, comt = self._scan_journal()
        if comt is None:
            dirty, dirty_end = self._journal_tail_state(self._journal_end)
            if dirty:
                # Fault A or B: crash remnant in the tail.  Discard the
                # uncommitted transaction; G is unchanged.
                os.pwrite(self.fd, b"\0" * (dirty_end - JOURNAL_START),
                          JOURNAL_START)
                os.fsync(self.fd)
                self._journal_end = JOURNAL_START
            # A clean tail is a pending transaction: leave it alone.
            return
        if comt == self.G + 1:
            # Fault C: committed but the header was never updated.  Redo the
            # transaction; the header is bumped exactly once, so the result
            # equals a normal commit and G is never duplicated.
            new_root = self._cow_apply(records)
            os.fsync(self.fd)
            self._write_header(comt, new_root, self.data_pages)
            self.G = comt
            self.root = new_root
        elif comt > self.G + 1:
            raise StoreError(
                f"journal commit generation {comt} inconsistent with G={self.G}"
            )
        # comt == self.G: fault D, already applied; comt < self.G: stale.
        self._clear_journal()

    # -------------------------------------------------------------- public

    def txn_op(self, op, key, value=b""):
        """Append one redo record to the tail region (fault point A)."""
        rec = REDO_HDR.pack(REDO_MAGIC, op, len(key), len(value)) + key + value
        rec += struct.pack("<I", zlib.crc32(rec))
        if _fault_point == "A":
            # Power loss in the middle of writing the redo record: only a
            # partial record reaches the disk.
            os.pwrite(self.fd, rec[: max(1, len(rec) // 2)], self._journal_end)
            os.fsync(self.fd)
            _fault("A")
        self._append_journal(rec)

    def commit(self):
        """Commit the pending transaction.  Returns False if there is none."""
        records, comt = self._scan_journal()
        if comt is not None:
            raise StoreError("journal holds a committed transaction; run recover")
        if not records:
            return False
        gen_new = self.G + 1
        marker = COMT_BODY.pack(COMT_MAGIC, gen_new)
        marker += struct.pack("<I", zlib.crc32(marker))
        if _fault_point == "B":
            # Power loss while writing the commit marker: only a torn
            # marker (bad crc) reaches the disk.
            os.pwrite(self.fd, marker[: max(1, len(marker) // 2)], self._journal_end)
            os.fsync(self.fd)
            _fault("B")
        self._append_journal(marker)
        new_root = self._cow_apply(records)
        os.fsync(self.fd)
        _fault("C")  # commit marker durable, header not yet updated
        self._write_header(gen_new, new_root, self.data_pages)
        self.G = gen_new
        self.root = new_root
        _fault("D")  # header updated, journal not yet cleared
        self._clear_journal()
        return True

    def rollback(self):
        """Discard the uncommitted tail.  Committed generations are untouchable."""
        records, comt = self._scan_journal()
        if comt is not None:
            raise StoreError(
                "cannot rollback: transaction is committed (recover instead)"
            )
        if not records:
            return False
        self._clear_journal()
        return True

    def get(self, key):
        if self.root == ROOT_EMPTY:
            return None
        idx0, idx1, key_hash = self._key_hash(key)
        entries = self._parse_internal(self._read_page(self.root))
        middle = entries[idx0]
        if not middle:
            return None
        entries = self._parse_internal(self._read_page(middle))
        leaf = entries[idx1]
        if not leaf:
            return None
        for entry_hash, entry_key, entry_value in self._parse_leaf(
            self._read_page(leaf)
        ):
            if entry_hash == key_hash and entry_key == key:
                return entry_value
        return None

    def dump(self):
        out = {}
        if self.root:
            self._walk(self.root, 0, out)
        return out

    def _walk(self, page_no, level, out):
        raw = self._read_page(page_no)
        if level < 2:
            for child in self._parse_internal(raw):
                if child:
                    self._walk(child, level + 1, out)
        else:
            for _, key, value in self._parse_leaf(raw):
                out[key] = value
