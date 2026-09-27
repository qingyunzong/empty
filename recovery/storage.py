"""Page-oriented data file.

The database file holds a fixed number of fixed-size page slots.  Each page
stores an 8-byte pageLSN followed by a JSON payload mapping keys to values.
The pageLSN is the LSN of the most recent log record whose effect is
reflected in the page; it makes redo idempotent.
"""

import hashlib
import json
import os
import struct

PAGE_COUNT = 16
PAGE_SIZE = 4096
_HEADER = struct.Struct(">QI")  # page_lsn (8 bytes), payload length (4 bytes)


def page_of(key):
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()
    return int(digest, 16) % PAGE_COUNT


class PageFile:
    def __init__(self, path):
        self.path = path
        if not os.path.exists(path):
            with open(path, "wb") as f:
                f.truncate(PAGE_COUNT * PAGE_SIZE)

    def read_page(self, page_id):
        """Return (page_lsn, data_dict) for the given page."""
        with open(self.path, "rb") as f:
            f.seek(page_id * PAGE_SIZE)
            header = f.read(_HEADER.size)
            page_lsn, length = _HEADER.unpack(header)
            payload = f.read(length)
        data = json.loads(payload.decode("utf-8")) if length else {}
        return page_lsn, data

    def write_page(self, page_id, page_lsn, data):
        payload = json.dumps(data, sort_keys=True).encode("utf-8")
        if _HEADER.size + len(payload) > PAGE_SIZE:
            raise ValueError("page %d overflow: %d bytes" % (page_id, len(payload)))
        with open(self.path, "r+b") as f:
            f.seek(page_id * PAGE_SIZE)
            f.write(_HEADER.pack(page_lsn, len(payload)))
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
