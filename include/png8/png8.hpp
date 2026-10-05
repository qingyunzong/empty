#pragma once

// png8: a minimal PNG decoder for 8-bit grayscale, non-interlaced images.
//
// Guarantees:
//  * Only bit depth 8, color type 0 (grayscale), interlace 0 is accepted.
//  * Every chunk's CRC-32 is verified; IHDR must be the first chunk.
//  * All five scanline filters (None/Sub/Up/Average/Paeth) are supported.
//  * zlib decompression is performed through an injectable adapter, so
//    callers can supply ready-made bytes (tests) or a real inflate.
//  * On any failure no partial image is published: DecodeResult::image is
//    engaged only after the whole stream decoded successfully.

#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

namespace png8 {

struct Image {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::vector<std::uint8_t> pixels;  // row-major, one byte per pixel
};

enum class Error {
    None = 0,
    BadSignature,
    UnexpectedEof,          // buffer ends in the middle of a chunk
    ChunkLengthOverflow,    // declared chunk length exceeds remaining bytes
    CrcMismatch,
    IhdrNotFirst,           // missing IHDR, or another chunk came first
    DuplicateIhdr,
    BadIhdrLength,
    UnsupportedBitDepth,
    UnsupportedColorType,
    UnsupportedCompression,
    UnsupportedFilterMethod,
    UnsupportedInterlace,
    ZeroDimensions,
    DimensionOverflow,      // width/height imply an unreasonably large image
    MissingIend,
    MissingIdat,
    NonConsecutiveIdat,
    UnknownCriticalChunk,
    BadIendLength,
    InflateFailed,          // the injected zlib adapter rejected the stream
    PixelDataLengthMismatch,
    BadScanlineFilter,
};

std::string_view to_string(Error error) noexcept;

// PNG CRC-32 (polynomial 0xEDB88320) over the given bytes.
std::uint32_t crc32(std::span<const std::uint8_t> data) noexcept;

// Injectable zlib adapter: maps a complete zlib stream to inflated bytes,
// or std::nullopt when the stream is invalid.
using InflateFn =
    std::function<std::optional<std::vector<std::uint8_t>>(std::span<const std::uint8_t>)>;

struct DecodeResult {
    std::optional<Image> image;  // engaged only on complete success
    Error error = Error::None;

    bool has_value() const noexcept { return image.has_value(); }
    explicit operator bool() const noexcept { return image.has_value(); }
};

// Decodes a whole PNG file. Never publishes a partial image: any bad chunk
// (CRC, ordering, length, unsupported feature) fails the whole decode.
DecodeResult decode(std::span<const std::uint8_t> png_bytes, const InflateFn& inflate);

}  // namespace png8
