#pragma once

// Minimal zlib codec limited to "stored" (uncompressed) deflate blocks.
// Handy as the default injectable adapter for png8::decode when no real
// zlib is available, and for building test fixtures without dependencies.

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace png8::zlib {

inline std::uint32_t adler32(std::span<const std::uint8_t> data) noexcept {
    std::uint32_t a = 1, b = 0;
    for (std::uint8_t byte : data) {
        a = (a + byte) % 65521u;
        b = (b + a) % 65521u;
    }
    return (b << 16) | a;
}

// Wraps raw bytes in a zlib stream made of stored deflate blocks.
inline std::vector<std::uint8_t> compress_stored(std::span<const std::uint8_t> raw) {
    std::vector<std::uint8_t> out;
    out.reserve(raw.size() + raw.size() / 65535 * 5 + 11);
    out.push_back(0x78);  // CMF: deflate, 32K window
    out.push_back(0x01);  // FLG: check bits, no preset dictionary
    std::size_t pos = 0;
    do {
        const std::size_t block = raw.size() - pos < 65535 ? raw.size() - pos : 65535;
        const bool final = pos + block == raw.size();
        out.push_back(final ? 0x01 : 0x00);  // BFINAL, BTYPE=00 (stored)
        const std::uint16_t len = static_cast<std::uint16_t>(block);
        const std::uint16_t nlen = static_cast<std::uint16_t>(~len);
        out.push_back(static_cast<std::uint8_t>(len & 0xFF));
        out.push_back(static_cast<std::uint8_t>(len >> 8));
        out.push_back(static_cast<std::uint8_t>(nlen & 0xFF));
        out.push_back(static_cast<std::uint8_t>(nlen >> 8));
        out.insert(out.end(), raw.begin() + static_cast<std::ptrdiff_t>(pos),
                   raw.begin() + static_cast<std::ptrdiff_t>(pos + block));
        pos += block;
    } while (pos < raw.size());
    const std::uint32_t sum = adler32(raw);
    for (int shift = 24; shift >= 0; shift -= 8)
        out.push_back(static_cast<std::uint8_t>(sum >> shift));
    return out;
}

// Inflates a zlib stream that consists solely of stored deflate blocks.
// Verifies the zlib header, LEN/NLEN pairs and the Adler-32 checksum.
inline std::optional<std::vector<std::uint8_t>> inflate_stored(
    std::span<const std::uint8_t> stream) {
    if (stream.size() < 2 + 5 + 4) return std::nullopt;
    const std::uint8_t cmf = stream[0], flg = stream[1];
    if ((cmf & 0x0F) != 8) return std::nullopt;             // method must be deflate
    if ((cmf >> 4) > 7) return std::nullopt;                // window size <= 32K
    if ((static_cast<unsigned>(cmf) * 256 + flg) % 31 != 0) return std::nullopt;
    if (flg & 0x20) return std::nullopt;                    // preset dictionary unsupported

    std::vector<std::uint8_t> out;
    std::size_t pos = 2;
    bool final = false;
    while (!final) {
        if (pos + 5 > stream.size()) return std::nullopt;
        const std::uint8_t header = stream[pos++];
        final = (header & 0x01) != 0;
        if ((header >> 1 & 0x03) != 0) return std::nullopt;  // only stored blocks
        const std::uint16_t len = static_cast<std::uint16_t>(stream[pos] | stream[pos + 1] << 8);
        const std::uint16_t nlen =
            static_cast<std::uint16_t>(stream[pos + 2] | stream[pos + 3] << 8);
        pos += 4;
        if (nlen != static_cast<std::uint16_t>(~len)) return std::nullopt;
        if (pos + len > stream.size()) return std::nullopt;
        out.insert(out.end(), stream.begin() + static_cast<std::ptrdiff_t>(pos),
                   stream.begin() + static_cast<std::ptrdiff_t>(pos + len));
        pos += len;
    }
    if (pos + 4 != stream.size()) return std::nullopt;  // trailing garbage rejected
    std::uint32_t expected = 0;
    for (std::size_t i = 0; i < 4; ++i) expected = expected << 8 | stream[pos + i];
    if (expected != adler32(out)) return std::nullopt;
    return out;
}

}  // namespace png8::zlib
