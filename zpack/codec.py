"""zpack: dictionary-based token-stream compression.

File format:
    u32be   D                dictionary entry count
    D x (u16be length + bytes)  dictionary entries
    varint  declared_size    declared decompressed size (canonical varint)
    token stream:
        0..127   literal byte
        128..255 dictionary reference, index = token - 128

Varint: 7 bits per group, little-endian groups, continuation bit 0x80.
Encodings must be canonical (shortest form) and at most 5 bytes; the 5th
byte must not set any of bits 0xF0 (value must fit in u32, no continuation).
"""

from __future__ import annotations

from collections import Counter

MAX_DICT_ENTRIES = 128
MAX_U32 = 0xFFFFFFFF
DEFAULT_MAX_OUTPUT = 1 << 28  # 256 MiB safety budget


class FormatError(Exception):
    """Input violates the format specification."""


class BudgetError(Exception):
    """Declared or actual output exceeds the allowed budget."""


def encode_varint(value: int) -> bytes:
    if not 0 <= value <= MAX_U32:
        raise ValueError(f"varint value out of u32 range: {value}")
    out = bytearray()
    while True:
        group = value & 0x7F
        value >>= 7
        if value:
            out.append(group | 0x80)
        else:
            out.append(group)
            return bytes(out)


def decode_varint(buf: bytes, pos: int = 0) -> tuple[int, int]:
    """Decode a canonical varint from buf[pos:]; return (value, new_pos)."""
    value = 0
    for i in range(5):
        if pos >= len(buf):
            raise FormatError("truncated varint")
        byte = buf[pos]
        pos += 1
        if i == 4 and byte & 0xF0:
            raise FormatError("varint exceeds 32 bits or 5 bytes")
        value |= (byte & 0x7F) << (7 * i)
        if not byte & 0x80:
            if i > 0 and byte & 0x7F == 0:
                raise FormatError("non-canonical varint (not shortest form)")
            return value, pos
    raise FormatError("varint exceeds 5 bytes")


def _build_dictionary(data: bytes, max_entries: int = MAX_DICT_ENTRIES) -> list[bytes]:
    """Pick dictionary entries: required high-byte singles, then the most
    profitable repeated substrings (savings = (len-1) * occurrences)."""
    entries: list[bytes] = []
    seen: set[bytes] = set()

    # Bytes >= 128 cannot be literals; they must come from the dictionary.
    for byte in sorted(set(data)):
        if byte >= 128:
            entries.append(bytes([byte]))
            seen.add(entries[-1])
    if len(entries) > max_entries:
        raise ValueError("too many distinct high bytes to encode")

    n = len(data)
    if n >= 2:
        best: dict[bytes, int] = {}
        for length in range(2, min(32, n) + 1):
            counts: Counter = Counter()
            for i in range(n - length + 1):
                counts[data[i:i + length]] += 1
            for sub, count in counts.items():
                if count >= 2:
                    best[sub] = count
        candidates = sorted(
            best.items(),
            key=lambda kv: (-(len(kv[0]) - 1) * kv[1], -len(kv[0]), kv[0]),
        )
        for sub, _count in candidates:
            if len(entries) >= max_entries:
                break
            if sub not in seen:
                seen.add(sub)
                entries.append(sub)
    return entries


def optimize_tokens(data: bytes, dictionary: list[bytes]) -> bytes:
    """Shortest token sequence via DP. Ties prefer the smallest dictionary
    index; a literal is used only when no dictionary entry matches."""
    n = len(data)
    dp = [0] * (n + 1)
    choice = [-1] * n  # -1 = literal, else dictionary index
    for i in range(n - 1, -1, -1):
        best = 1 + dp[i + 1]
        best_choice = -1
        for idx, entry in enumerate(dictionary):
            if entry and data.startswith(entry, i):
                cost = 1 + dp[i + len(entry)]
                if cost < best or (cost == best and best_choice == -1):
                    best = cost
                    best_choice = idx
        dp[i] = best
        choice[i] = best_choice
    tokens = bytearray()
    i = 0
    while i < n:
        c = choice[i]
        if c == -1:
            if data[i] >= 128:
                raise ValueError("byte >= 128 has no dictionary entry")
            tokens.append(data[i])
            i += 1
        else:
            tokens.append(128 + c)
            i += len(dictionary[c])
    return bytes(tokens)


def encode(data: bytes, max_entries: int = MAX_DICT_ENTRIES) -> bytes:
    dictionary = _build_dictionary(data, max_entries)
    tokens = optimize_tokens(data, dictionary)
    # Drop dictionary entries that no token references; remapping indices
    # keeps the (already optimal) token count unchanged.
    used = sorted({t - 128 for t in tokens if t >= 128})
    if len(used) != len(dictionary):
        remap = {old: new for new, old in enumerate(used)}
        dictionary = [dictionary[old] for old in used]
        tokens = bytes(t if t < 128 else 128 + remap[t - 128] for t in tokens)
    out = bytearray()
    out += len(dictionary).to_bytes(4, "big")
    for entry in dictionary:
        out += len(entry).to_bytes(2, "big")
        out += entry
    out += encode_varint(len(data))
    out += tokens
    return bytes(out)


def decode(buf: bytes, max_output: int = DEFAULT_MAX_OUTPUT) -> bytes:
    if len(buf) < 4:
        raise FormatError("truncated header")
    count = int.from_bytes(buf[0:4], "big")
    pos = 4
    dictionary: list[bytes] = []
    for _ in range(count):
        if pos + 2 > len(buf):
            raise FormatError("truncated dictionary entry length")
        length = int.from_bytes(buf[pos:pos + 2], "big")
        pos += 2
        if pos + length > len(buf):
            raise FormatError("truncated dictionary entry")
        dictionary.append(buf[pos:pos + length])
        pos += length
    declared, pos = decode_varint(buf, pos)
    if declared > max_output:
        raise BudgetError(
            f"declared size {declared} exceeds budget {max_output}")
    out = bytearray()
    while pos < len(buf):
        token = buf[pos]
        pos += 1
        if token < 128:
            out.append(token)
        else:
            idx = token - 128
            if idx >= count:
                raise FormatError(f"dictionary index {idx} out of range")
            out += dictionary[idx]
        if len(out) > declared:
            raise BudgetError("output exceeds declared size")
    if len(out) != declared:
        raise FormatError(
            f"output size {len(out)} != declared size {declared}")
    return bytes(out)
