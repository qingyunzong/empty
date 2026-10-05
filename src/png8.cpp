#include "png8/png8.hpp"

#include <array>
#include <cstring>
#include <limits>

namespace png8 {

namespace {

constexpr std::array<std::uint8_t, 8> kSignature = {137, 80, 78, 71, 13, 10, 26, 10};

// Defense-in-depth cap: 8-bit gray needs height * (1 + width) filtered bytes,
// and anything beyond 4 GiB of filtered data is rejected up front so that
// hostile dimensions cannot trigger huge allocations.
constexpr std::uint64_t kMaxFilteredBytes = std::uint64_t{1} << 32;

constexpr std::uint32_t kIhdr = 0x49484452;  // "IHDR"
constexpr std::uint32_t kIdat = 0x49444154;  // "IDAT"
constexpr std::uint32_t kIend = 0x49454E44;  // "IEND"

std::uint32_t read_be32(std::span<const std::uint8_t> data, std::size_t pos) {
    return static_cast<std::uint32_t>(data[pos]) << 24 |
           static_cast<std::uint32_t>(data[pos + 1]) << 16 |
           static_cast<std::uint32_t>(data[pos + 2]) << 8 |
           static_cast<std::uint32_t>(data[pos + 3]);
}

std::uint8_t paeth(std::uint8_t a, std::uint8_t b, std::uint8_t c) {
    const int p = static_cast<int>(a) + static_cast<int>(b) - static_cast<int>(c);
    const int pa = p > static_cast<int>(a) ? p - static_cast<int>(a) : static_cast<int>(a) - p;
    const int pb = p > static_cast<int>(b) ? p - static_cast<int>(b) : static_cast<int>(b) - p;
    const int pc = p > static_cast<int>(c) ? p - static_cast<int>(c) : static_cast<int>(c) - p;
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

Error unfilter(std::span<const std::uint8_t> filtered, std::uint32_t width,
               std::uint32_t height, std::vector<std::uint8_t>& pixels) {
    const std::size_t stride = width;  // 1 byte per pixel
    const std::size_t row_bytes = stride + 1;
    pixels.assign(stride * height, 0);
    std::vector<std::uint8_t> prev(stride, 0);
    for (std::uint32_t y = 0; y < height; ++y) {
        const std::uint8_t filter = filtered[static_cast<std::size_t>(y) * row_bytes];
        const std::uint8_t* row = filtered.data() + static_cast<std::size_t>(y) * row_bytes + 1;
        std::uint8_t* out = pixels.data() + static_cast<std::size_t>(y) * stride;
        switch (filter) {
            case 0:  // None
                std::memcpy(out, row, stride);
                break;
            case 1:  // Sub
                for (std::size_t x = 0; x < stride; ++x) {
                    const std::uint8_t left = x >= 1 ? out[x - 1] : 0;
                    out[x] = static_cast<std::uint8_t>(row[x] + left);
                }
                break;
            case 2:  // Up
                for (std::size_t x = 0; x < stride; ++x)
                    out[x] = static_cast<std::uint8_t>(row[x] + prev[x]);
                break;
            case 3:  // Average
                for (std::size_t x = 0; x < stride; ++x) {
                    const std::uint8_t left = x >= 1 ? out[x - 1] : 0;
                    out[x] = static_cast<std::uint8_t>(
                        row[x] + (static_cast<unsigned>(left) + prev[x]) / 2);
                }
                break;
            case 4:  // Paeth
                for (std::size_t x = 0; x < stride; ++x) {
                    const std::uint8_t left = x >= 1 ? out[x - 1] : 0;
                    const std::uint8_t up_left = x >= 1 ? prev[x - 1] : 0;
                    out[x] = static_cast<std::uint8_t>(row[x] + paeth(left, prev[x], up_left));
                }
                break;
            default:
                return Error::BadScanlineFilter;
        }
        std::memcpy(prev.data(), out, stride);
    }
    return Error::None;
}

}  // namespace

std::string_view to_string(Error error) noexcept {
    switch (error) {
        case Error::None: return "no error";
        case Error::BadSignature: return "bad PNG signature";
        case Error::UnexpectedEof: return "unexpected end of data";
        case Error::ChunkLengthOverflow: return "chunk length exceeds remaining data";
        case Error::CrcMismatch: return "chunk CRC mismatch";
        case Error::IhdrNotFirst: return "IHDR is missing or not the first chunk";
        case Error::DuplicateIhdr: return "duplicate IHDR chunk";
        case Error::BadIhdrLength: return "IHDR data length is not 13";
        case Error::UnsupportedBitDepth: return "only bit depth 8 is supported";
        case Error::UnsupportedColorType: return "only grayscale (color type 0) is supported";
        case Error::UnsupportedCompression: return "unknown compression method";
        case Error::UnsupportedFilterMethod: return "unknown filter method";
        case Error::UnsupportedInterlace: return "interlaced images are not supported";
        case Error::ZeroDimensions: return "image dimensions must be non-zero";
        case Error::DimensionOverflow: return "image dimensions are unreasonably large";
        case Error::MissingIend: return "missing IEND chunk";
        case Error::MissingIdat: return "missing IDAT chunk";
        case Error::NonConsecutiveIdat: return "IDAT chunks must be consecutive";
        case Error::UnknownCriticalChunk: return "unknown critical chunk";
        case Error::BadIendLength: return "IEND data length is not 0";
        case Error::InflateFailed: return "zlib decompression failed";
        case Error::PixelDataLengthMismatch: return "inflated data has wrong length";
        case Error::BadScanlineFilter: return "unknown scanline filter type";
    }
    return "unknown error";
}

std::uint32_t crc32(std::span<const std::uint8_t> data) noexcept {
    static const std::array<std::uint32_t, 256> table = [] {
        std::array<std::uint32_t, 256> t{};
        for (std::uint32_t n = 0; n < 256; ++n) {
            std::uint32_t c = n;
            for (int k = 0; k < 8; ++k)
                c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            t[n] = c;
        }
        return t;
    }();
    std::uint32_t crc = 0xFFFFFFFFu;
    for (std::uint8_t byte : data)
        crc = table[(crc ^ byte) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFu;
}

DecodeResult decode(std::span<const std::uint8_t> png, const InflateFn& inflate) {
    auto fail = [](Error e) {
        DecodeResult r;
        r.error = e;
        return r;
    };

    if (png.size() < kSignature.size() ||
        std::memcmp(png.data(), kSignature.data(), kSignature.size()) != 0)
        return fail(Error::BadSignature);

    std::size_t pos = kSignature.size();
    bool seen_ihdr = false;
    bool seen_iend = false;
    bool idat_started = false;
    bool idat_ended = false;
    std::uint32_t width = 0, height = 0;
    std::uint64_t expected_filtered = 0;
    std::vector<std::uint8_t> idat;

    while (!seen_iend) {
        if (pos == png.size())
            return fail(seen_ihdr ? Error::MissingIend : Error::IhdrNotFirst);
        if (png.size() - pos < 8) return fail(Error::UnexpectedEof);

        const std::uint32_t length = read_be32(png, pos);
        const std::uint32_t type = read_be32(png, pos + 4);
        const std::size_t data_pos = pos + 8;
        // Length overflow rejection: declared length must fit in the buffer.
        if (length > png.size() - data_pos || png.size() - data_pos - length < 4)
            return fail(Error::ChunkLengthOverflow);

        const std::span<const std::uint8_t> chunk_data = png.subspan(data_pos, length);
        const std::uint32_t expected_crc = read_be32(png, data_pos + length);

        // CRC covers chunk type + data.
        std::vector<std::uint8_t> crc_input;
        crc_input.reserve(4 + length);
        crc_input.insert(crc_input.end(), png.begin() + static_cast<std::ptrdiff_t>(pos + 4),
                         png.begin() + static_cast<std::ptrdiff_t>(data_pos + length));
        if (crc32(crc_input) != expected_crc) return fail(Error::CrcMismatch);

        if (!seen_ihdr && type != kIhdr) return fail(Error::IhdrNotFirst);

        if (type != kIdat && idat_started) idat_ended = true;

        switch (type) {
            case kIhdr: {
                if (seen_ihdr) return fail(Error::DuplicateIhdr);
                if (length != 13) return fail(Error::BadIhdrLength);
                width = read_be32(chunk_data, 0);
                height = read_be32(chunk_data, 4);
                const std::uint8_t bit_depth = chunk_data[8];
                const std::uint8_t color_type = chunk_data[9];
                const std::uint8_t compression = chunk_data[10];
                const std::uint8_t filter_method = chunk_data[11];
                const std::uint8_t interlace = chunk_data[12];
                if (width == 0 || height == 0) return fail(Error::ZeroDimensions);
                if (bit_depth != 8) return fail(Error::UnsupportedBitDepth);
                if (color_type != 0) return fail(Error::UnsupportedColorType);
                if (compression != 0) return fail(Error::UnsupportedCompression);
                if (filter_method != 0) return fail(Error::UnsupportedFilterMethod);
                if (interlace != 0) return fail(Error::UnsupportedInterlace);
                expected_filtered =
                    static_cast<std::uint64_t>(height) * (static_cast<std::uint64_t>(width) + 1);
                if (expected_filtered > kMaxFilteredBytes) return fail(Error::DimensionOverflow);
                seen_ihdr = true;
                break;
            }
            case kIdat: {
                if (idat_ended) return fail(Error::NonConsecutiveIdat);
                idat_started = true;
                if (idat.size() + length > kMaxFilteredBytes * 2)
                    return fail(Error::DimensionOverflow);
                idat.insert(idat.end(), chunk_data.begin(), chunk_data.end());
                break;
            }
            case kIend: {
                if (length != 0) return fail(Error::BadIendLength);
                seen_iend = true;
                break;
            }
            default: {
                // Unknown critical chunk (first letter uppercase) must fail.
                const std::uint8_t first = static_cast<std::uint8_t>(type >> 24);
                if ((first & 0x20) == 0) return fail(Error::UnknownCriticalChunk);
                break;  // ancillary chunk: CRC-checked above, then skipped
            }
        }
        pos = data_pos + length + 4;
    }

    if (!idat_started) return fail(Error::MissingIdat);

    auto inflated = inflate(idat);
    if (!inflated) return fail(Error::InflateFailed);
    if (inflated->size() != expected_filtered) return fail(Error::PixelDataLengthMismatch);

    Image image;
    image.width = width;
    image.height = height;
    if (const Error e = unfilter(*inflated, width, height, image.pixels); e != Error::None)
        return fail(e);

    DecodeResult result;
    result.image = std::move(image);
    return result;
}

}  // namespace png8
