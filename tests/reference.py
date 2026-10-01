"""Independent one-shot reference implementation of the rchunk spec.

Simulates the rolling state byte by byte over the whole input in a
single pass. Used by the tests to cross-check the streaming Chunker.
Written directly from the spec:

- window W=48, 31-bit polynomial rolling checksum (base 257, mod 2**31)
- cut when low 13 bits of the checksum are all 1s and length >= 64
- forced cut at length 4096 even without a fingerprint match; when a
  fingerprint match and the forced cut coincide on the same byte, the
  forced cut (condition reached first, by length) is the one taken
- final partial chunk is cut at EOF
- rolling state resets at every boundary
"""

from collections import deque

W = 48
MIN_SIZE = 64
MAX_SIZE = 4096
MASK = 0x1FFF
MOD = 1 << 31
BASE = 257
POW = pow(BASE, W - 1, MOD)


def reference_chunks(data: bytes) -> list[tuple[int, int]]:
    bounds: list[tuple[int, int]] = []
    start = 0
    h = 0
    window: deque[int] = deque()
    for i, byte in enumerate(data):
        if len(window) == W:
            h = (h - window.popleft() * POW) % MOD
        window.append(byte)
        h = (h * BASE + byte) % MOD
        length = i - start + 1
        if length == MAX_SIZE:
            bounds.append((start, length))
            start = i + 1
            h = 0
            window.clear()
        elif length >= MIN_SIZE and (h & MASK) == MASK:
            bounds.append((start, length))
            start = i + 1
            h = 0
            window.clear()
    if start < len(data):
        bounds.append((start, len(data) - start))
    return bounds
