"""zpack: tiny dictionary-based compression format.

Format:
    header:  D              canonical varint (u32), dictionary entry count
             D x (L, bytes) L = canonical varint (u16) entry length, then L bytes
    payload: token stream; byte 0..127 = literal, byte 128..255 = dictionary
             reference with index (byte - 128)

Integers use canonical varints: 7 bits per group, little-endian groups,
continuation bit 0x80, at most 5 bytes (u32 range), shortest form only.
"""

__all__ = [
    "ZpackError",
    "FormatError",
    "BudgetError",
    "encode_varint",
    "decode_varint",
    "compress",
    "decompress",
    "MAX_DICT_ENTRIES",
    "MAX_ENTRY_LEN",
]

MAX_DICT_ENTRIES = 128          # token bytes only encode indices 0..127
MAX_ENTRY_LEN = 0xFFFF          # u16
_MAX_VARINT_BYTES = 5           # ceil(32 / 7)
_U32_MAX = 0xFFFFFFFF
_MAX_ENTRY_CANDIDATE_LEN = 32


class ZpackError(Exception):
    """Base class for zpack errors."""


class FormatError(ZpackError):
    """The input bytes violate the zpack format."""


class BudgetError(ZpackError):
    """The declared decompression budget would be exceeded."""


def encode_varint(value):
    """Encode a u32 as a canonical (shortest-form) varint."""
    if not 0 <= value <= _U32_MAX:
        raise ValueError("varint value out of u32 range: %r" % (value,))
    out = bytearray()
    while True:
        group = value & 0x7F
        value >>= 7
        if value:
            out.append(group | 0x80)
        else:
            out.append(group)
            return bytes(out)


def decode_varint(data, offset=0):
    """Decode a canonical varint at ``offset``.

    Returns ``(value, new_offset)``. Raises FormatError for truncated input,
    non-shortest encodings, encodings longer than 5 bytes, and values that
    exceed the u32 range (high bits set in the 5th byte).
    """
    value = 0
    shift = 0
    for i in range(_MAX_VARINT_BYTES):
        if offset + i >= len(data):
            raise FormatError("truncated varint")
        byte = data[offset + i]
        if i == _MAX_VARINT_BYTES - 1:
            if byte & 0x80:
                raise FormatError("varint exceeds 5 bytes")
            if byte & 0x70:
                raise FormatError("varint exceeds u32 range")
        group = byte & 0x7F
        value |= group << shift
        if not byte & 0x80:
            if i > 0 and group == 0:
                raise FormatError("non-canonical varint (not shortest form)")
            return value, offset + i + 1
        shift += 7
    raise FormatError("varint exceeds 5 bytes")  # unreachable


def _build_dictionary(data, max_entries=MAX_DICT_ENTRIES):
    """Build the dictionary for ``data``.

    Literal tokens only cover byte values 0..127, so every byte value
    >= 128 present in the data gets a mandatory single-byte entry (there
    are at most 128 distinct ones, exactly filling the index space).
    Remaining slots are filled with repeated substrings that have
    positive savings.
    """
    n = len(data)
    mandatory = [bytes([b]) for b in range(128, 256) if b in data]
    if len(mandatory) >= max_entries or n < 2:
        return mandatory[:max_entries]
    counts = {}
    for length in range(2, min(_MAX_ENTRY_CANDIDATE_LEN, n) + 1):
        seen = {}
        for i in range(n - length + 1):
            sub = data[i:i + length]
            seen[sub] = seen.get(sub, 0) + 1
        for sub, count in seen.items():
            if count >= 2:
                counts[sub] = count
    scored = []
    for sub, count in counts.items():
        # each use saves len(sub)-1 token bytes; storing costs len(sub) plus
        # the varint length prefix
        saving = count * (len(sub) - 1) - len(sub) - len(encode_varint(len(sub)))
        if saving > 0:
            scored.append((saving, sub))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return mandatory + [sub for _, sub in scored[:max_entries - len(mandatory)]]


def _encode_tokens(data, dictionary):
    """Shortest token sequence for ``data`` given ``dictionary``.

    Ties between equally short parses prefer a dictionary reference over a
    literal, and among references the smallest dictionary index. Literals
    are used when no dictionary entry matches optimally.
    """
    n = len(data)
    count = [0] * (n + 1)
    choice = [0] * (n + 1)
    for i in range(n - 1, -1, -1):
        best_count = None
        best_key = None
        best_token = None
        if data[i] < 128:
            # literal tokens can only carry byte values 0..127
            best_count = 1 + count[i + 1]
            best_key = (1, data[i])      # literals sort after references
            best_token = data[i]
        for index, entry in enumerate(dictionary):
            if data.startswith(entry, i):
                cand_count = 1 + count[i + len(entry)]
                cand_key = (0, index)
                if best_count is None or cand_count < best_count or (
                    cand_count == best_count and cand_key < best_key
                ):
                    best_count = cand_count
                    best_key = cand_key
                    best_token = 128 + index
        if best_token is None:
            raise ZpackError("byte at offset %d is not encodable" % i)
        count[i] = best_count
        choice[i] = best_token
    tokens = []
    i = 0
    while i < n:
        token = choice[i]
        tokens.append(token)
        i += 1 if token < 128 else len(dictionary[token - 128])
    return tokens


def compress(data):
    """Compress ``data`` (bytes) into the zpack format."""
    dictionary = _build_dictionary(data)
    tokens = _encode_tokens(data, dictionary)
    out = bytearray()
    out += encode_varint(len(dictionary))
    for entry in dictionary:
        out += encode_varint(len(entry))
        out += entry
    out += bytes(tokens)
    return bytes(out)


def decompress(blob, max_output=None):
    """Decompress a zpack blob.

    Raises FormatError on malformed input. If ``max_output`` is given and
    the decoded size would exceed it, raises BudgetError before producing
    any output.
    """
    dict_count, offset = decode_varint(blob, 0)
    dictionary = []
    for _ in range(dict_count):
        length, offset = decode_varint(blob, offset)
        if length > MAX_ENTRY_LEN:
            raise FormatError("dictionary entry length exceeds u16")
        if offset + length > len(blob):
            raise FormatError("truncated dictionary entry")
        dictionary.append(blob[offset:offset + length])
        offset += length

    # Pass 1: validate the token stream and measure the decoded size.
    # Abort with BudgetError as soon as the budget is exceeded, without
    # emitting anything.
    total = 0
    for token in blob[offset:]:
        if token < 128:
            total += 1
        else:
            index = token - 128
            if index >= dict_count:
                raise FormatError("dictionary index out of range: %d" % index)
            total += len(dictionary[index])
        if max_output is not None and total > max_output:
            raise BudgetError(
                "decoded size exceeds budget of %d bytes" % max_output
            )

    # Pass 2: emit output.
    out = bytearray()
    for token in blob[offset:]:
        if token < 128:
            out.append(token)
        else:
            out += dictionary[token - 128]
    return bytes(out)
