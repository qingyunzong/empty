"""Slotted page file and a small LRU buffer pool with steal/no-force policy.

Each page stores a JSON key->value map plus a pageLSN in its header. Dirty
pages may be evicted (stolen) before their transaction commits; the WAL rule
is enforced by syncing the log before every page write.
"""

from __future__ import annotations

import json
import struct
from collections import OrderedDict

PAGE_HEADER = struct.Struct("<qI")  # pageLSN, payload length


class PageOverflowError(Exception):
    pass


class Page:
    __slots__ = ("page_id", "page_lsn", "kv", "dirty")

    def __init__(self, page_id: int, page_lsn: int = -1, kv: dict | None = None):
        self.page_id = page_id
        self.page_lsn = page_lsn
        self.kv = kv if kv is not None else {}
        self.dirty = False

    def encode(self, page_size: int) -> bytes:
        body = json.dumps(self.kv, sort_keys=True).encode("utf-8")
        blob = PAGE_HEADER.pack(self.page_lsn, len(body)) + body
        if len(blob) > page_size:
            raise PageOverflowError(
                f"page {self.page_id} needs {len(blob)} > {page_size} bytes")
        return blob + b"\x00" * (page_size - len(blob))


def decode_page(page_id: int, data: bytes, page_size: int) -> Page:
    if len(data) < PAGE_HEADER.size:
        return Page(page_id)
    page_lsn, blen = PAGE_HEADER.unpack_from(data)
    if blen == 0 or PAGE_HEADER.size + blen > page_size:
        return Page(page_id)
    kv = json.loads(data[PAGE_HEADER.size:PAGE_HEADER.size + blen])
    return Page(page_id, page_lsn, kv)


class BufferPool:
    def __init__(self, adapter, path: str, log, num_pages: int,
                 page_size: int, capacity: int, emit) -> None:
        self.adapter = adapter
        self.path = path
        self.log = log
        self.num_pages = num_pages
        self.page_size = page_size
        self.capacity = max(1, capacity)
        self.emit = emit
        self.cache: OrderedDict[int, Page] = OrderedDict()

    def fetch(self, page_id: int) -> Page:
        if page_id in self.cache:
            self.cache.move_to_end(page_id)
            return self.cache[page_id]
        while len(self.cache) >= self.capacity:
            self._evict_lru()
        data = self.adapter.pread(self.path, page_id * self.page_size,
                                  self.page_size)
        page = decode_page(page_id, data, self.page_size)
        self.cache[page_id] = page
        return page

    def _evict_lru(self) -> None:
        page_id, page = next(iter(self.cache.items()))
        if page.dirty:
            self._write_page(page)
        del self.cache[page_id]

    def _write_page(self, page: Page) -> None:
        # WAL rule: the log must be durable up to pageLSN before the page.
        self.log.flush(sync=True)
        self.emit("page", "page_write",
                  f"WAL rule: log synced up to pageLSN {page.page_lsn} "
                  f"before writing dirty page {page.page_id} (steal allowed)",
                  page=page.page_id, lsn=page.page_lsn)
        self.adapter.pwrite(self.path, page.page_id * self.page_size,
                            page.encode(self.page_size))
        self.adapter.sync(self.path)
        page.dirty = False

    def flush_all(self) -> None:
        for page in list(self.cache.values()):
            if page.dirty:
                self._write_page(page)
