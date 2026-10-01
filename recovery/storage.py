"""Page-oriented disk storage.

The database file is a fixed array of pages. Every page starts with an
8-byte pageLSN header (the LSN of the most recent log record applied to
the page) followed by fixed-size 8-byte signed integer slots. A logical
key maps deterministically to (page, slot), so no directory is needed.
"""

import os
import struct

PAGE_SIZE = 128
HEADER_SIZE = 8
SLOT_SIZE = 8
NUM_PAGES = 8
SLOTS_PER_PAGE = (PAGE_SIZE - HEADER_SIZE) // SLOT_SIZE
MAX_KEY = NUM_PAGES * SLOTS_PER_PAGE

_LSN = struct.Struct("<Q")
_VALUE = struct.Struct("<q")


def locate(key):
    """Map a logical key to (page_no, slot_index)."""
    if not 0 <= key < MAX_KEY:
        raise ValueError(f"key {key} out of range [0, {MAX_KEY})")
    return divmod(key, SLOTS_PER_PAGE)


def get_page_lsn(page):
    return _LSN.unpack_from(page, 0)[0]


def set_page_lsn(page, lsn):
    _LSN.pack_into(page, 0, lsn)


def read_slot(page, slot):
    return _VALUE.unpack_from(page, HEADER_SIZE + slot * SLOT_SIZE)[0]


def write_slot(page, slot, value):
    _VALUE.pack_into(page, HEADER_SIZE + slot * SLOT_SIZE, value)


class PageFile:
    """Raw paged file on disk. This is the only state that survives a crash."""

    def __init__(self, path):
        self.path = path
        if not os.path.exists(path):
            with open(path, "wb") as fh:
                fh.write(bytes(NUM_PAGES * PAGE_SIZE))
        self._fh = open(path, "r+b")

    def read_page(self, page_no):
        self._fh.seek(page_no * PAGE_SIZE)
        data = self._fh.read(PAGE_SIZE)
        if len(data) != PAGE_SIZE:
            raise IOError(f"short read on page {page_no}")
        return bytearray(data)

    def write_page(self, page_no, page):
        if len(page) != PAGE_SIZE:
            raise ValueError("page buffer must be exactly PAGE_SIZE")
        self._fh.seek(page_no * PAGE_SIZE)
        self._fh.write(page)
        self._fh.flush()
        os.fsync(self._fh.fileno())

    def close(self):
        self._fh.close()
