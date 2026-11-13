#include "dataeng.hpp"

#include <algorithm>
#include <string>

// Minimal libzstd C API surface (the runtime library is linked directly).
extern "C" {
std::size_t ZSTD_findFrameCompressedSize(const void* src, std::size_t srcSize);
unsigned ZSTD_isError(std::size_t code);
const char* ZSTD_getErrorName(std::size_t code);
unsigned long long ZSTD_getFrameContentSize(const void* src, std::size_t srcSize);
std::size_t ZSTD_decompress(void* dst, std::size_t dstCapacity,
                            const void* src, std::size_t srcSize);
}

namespace dataeng {
namespace {

constexpr std::uint32_t kZstdFrameMagic = 0xFD2FB528u;
constexpr std::uint32_t kSkippableMagicMask = 0xFFFFFFF0u;
constexpr std::uint32_t kSkippableMagicValue = 0x184D2A50u;
constexpr std::uint32_t kSeekTableFrameMagic = 0x184D2A5Eu;
constexpr std::uint32_t kSeekableFooterMagic = 0x8F92EAB1u;
constexpr std::uint8_t kDescriptorChecksumFlag = 0x20u;
constexpr std::uint8_t kFrameHeaderChecksumFlag = 0x04u;
constexpr unsigned long long kContentSizeUnknown = ~0ull;
constexpr unsigned long long kContentSizeError = ~0ull - 1;

std::uint32_t readLe32(const std::byte* p) {
    return static_cast<std::uint32_t>(p[0]) |
           (static_cast<std::uint32_t>(p[1]) << 8) |
           (static_cast<std::uint32_t>(p[2]) << 16) |
           (static_cast<std::uint32_t>(p[3]) << 24);
}

std::string zstdError(std::size_t code) {
    return ZSTD_getErrorName(code);
}

}  // namespace

SeekableIndex SeekableIndex::parse(std::span<const std::byte> file) {
    struct FrameSpan {
        std::uint64_t offset;
        std::uint64_t size;
    };
    std::vector<FrameSpan> frames;
    std::uint64_t table_offset = 0;
    std::uint64_t table_size = 0;
    bool table_found = false;

    std::uint64_t pos = 0;
    while (pos < file.size()) {
        if (file.size() - pos < 4) {
            throw SeekableIndexError("truncated frame header");
        }
        const std::uint32_t magic = readLe32(file.data() + pos);
        if ((magic & kSkippableMagicMask) == kSkippableMagicValue) {
            if (file.size() - pos < 8) {
                throw SeekableIndexError("truncated skippable frame header");
            }
            const std::uint32_t payload_size = readLe32(file.data() + pos + 4);
            if (file.size() - pos - 8 < payload_size) {
                throw SeekableIndexError("truncated skippable frame payload");
            }
            const std::uint64_t total = 8ull + payload_size;
            if (magic != kSeekTableFrameMagic) {
                throw SeekableIndexError(
                    "unexpected skippable frame inside seekable file");
            }
            if (pos + total != file.size()) {
                throw SeekableIndexError(
                    "seek table is not the last frame of the file");
            }
            table_offset = pos + 8;
            table_size = payload_size;
            table_found = true;
            pos += total;
            break;
        }
        if (magic != kZstdFrameMagic) {
            throw SeekableIndexError("invalid frame magic at offset " +
                                     std::to_string(pos));
        }
        const std::size_t frame_size =
            ZSTD_findFrameCompressedSize(file.data() + pos, file.size() - pos);
        if (ZSTD_isError(frame_size)) {
            throw SeekableIndexError("corrupt frame at offset " +
                                     std::to_string(pos) + ": " +
                                     zstdError(frame_size));
        }
        frames.push_back({pos, frame_size});
        pos += frame_size;
    }

    if (!table_found) {
        throw SeekableIndexError("missing seek table");
    }
    if (frames.empty()) {
        throw SeekableIndexError("seek table without any data frames");
    }

    if (table_size < 9) {
        throw SeekableIndexError("seek table too small");
    }
    const std::byte* table = file.data() + table_offset;
    const std::uint32_t num_frames = readLe32(table);
    const std::uint8_t descriptor = static_cast<std::uint8_t>(table[4]);
    if (descriptor & ~kDescriptorChecksumFlag) {
        throw SeekableIndexError("seek table descriptor reserved bits set");
    }
    const bool has_checksums = (descriptor & kDescriptorChecksumFlag) != 0;
    if (num_frames == 0) {
        throw SeekableIndexError("seek table declares zero frames");
    }
    const std::uint64_t entry_size = has_checksums ? 12u : 8u;
    const std::uint64_t expected_size = 9ull + entry_size * num_frames;
    if (expected_size != table_size) {
        throw SeekableIndexError("seek table size does not match frame count");
    }
    if (readLe32(table + table_size - 4) != kSeekableFooterMagic) {
        throw SeekableIndexError("bad seekable footer magic");
    }
    if (num_frames != frames.size()) {
        throw SeekableIndexError("seek table frame count does not match file");
    }

    SeekableIndex index;
    index.has_checksums_ = has_checksums;
    index.entries_.reserve(num_frames);

    std::uint64_t compressed_offset = 0;
    std::uint64_t decompressed_offset = 0;
    for (std::uint32_t i = 0; i < num_frames; ++i) {
        const std::byte* entry = table + 5 + entry_size * i;
        const std::uint32_t compressed_size = readLe32(entry);
        const std::uint32_t decompressed_size = readLe32(entry + 4);
        std::optional<std::uint32_t> checksum;
        if (has_checksums) {
            checksum = readLe32(entry + 8);
        }

        const FrameSpan& frame = frames[i];
        if (compressed_size != frame.size) {
            throw SeekableIndexError(
                "compressed size mismatch at frame " + std::to_string(i) +
                ": index does not match actual frame boundaries");
        }

        const unsigned long long content_size = ZSTD_getFrameContentSize(
            file.data() + frame.offset, frame.size);
        if (content_size != kContentSizeUnknown &&
            content_size != kContentSizeError &&
            content_size != decompressed_size) {
            throw SeekableIndexError(
                "decompressed size mismatch at frame " + std::to_string(i));
        }

        if (checksum.has_value()) {
            const std::uint8_t frame_header =
                static_cast<std::uint8_t>(file[frame.offset + 4]);
            if ((frame_header & kFrameHeaderChecksumFlag) == 0) {
                throw SeekableIndexError(
                    "index checksum but frame " + std::to_string(i) +
                    " has no checksum");
            }
            const std::uint32_t trailer =
                readLe32(file.data() + frame.offset + frame.size - 4);
            if (trailer != *checksum) {
                throw SeekableIndexError("checksum mismatch at frame " +
                                         std::to_string(i));
            }
        }

        index.entries_.push_back({compressed_offset, decompressed_offset,
                                  compressed_size, decompressed_size,
                                  checksum});
        compressed_offset += compressed_size;
        decompressed_offset += decompressed_size;
    }

    if (compressed_offset + 8 + table_size != file.size()) {
        throw SeekableIndexError(
            "index compressed size sum does not match frame boundaries");
    }

    index.compressed_size_ = compressed_offset;
    index.decompressed_size_ = decompressed_offset;
    return index;
}

std::vector<std::byte> SeekableIndex::readRange(
    std::span<const std::byte> file, std::uint64_t offset,
    std::uint64_t length) const {
    if (length == 0) {
        return {};
    }
    if (offset > decompressed_size_ || length > decompressed_size_ - offset) {
        throw SeekableRangeError("range [" + std::to_string(offset) + ", " +
                                 std::to_string(offset + length) +
                                 ") outside decompressed size " +
                                 std::to_string(decompressed_size_));
    }

    const std::uint64_t end = offset + length;
    std::vector<std::byte> out;
    out.reserve(length);

    auto it = std::upper_bound(
        entries_.begin(), entries_.end(), offset,
        [](std::uint64_t value, const SeekFrameEntry& entry) {
            return value < entry.decompressed_offset;
        });
    if (it != entries_.begin()) {
        --it;
    }

    for (; it != entries_.end() && it->decompressed_offset < end; ++it) {
        if (it->compressed_offset + it->compressed_size > file.size()) {
            throw SeekableIndexError("frame data outside file contents");
        }
        std::vector<std::byte> frame_data(
            std::max<std::uint32_t>(it->decompressed_size, 1));
        const std::size_t result =
            ZSTD_decompress(frame_data.data(), it->decompressed_size,
                            file.data() + it->compressed_offset,
                            it->compressed_size);
        if (ZSTD_isError(result)) {
            throw SeekableIndexError("frame decompression failed: " +
                                     zstdError(result));
        }
        if (result != it->decompressed_size) {
            throw SeekableIndexError(
                "decompressed size mismatch during range read");
        }
        const std::uint64_t lo = std::max(offset, it->decompressed_offset);
        const std::uint64_t hi =
            std::min(end, it->decompressed_offset + it->decompressed_size);
        out.insert(out.end(), frame_data.begin() + (lo - it->decompressed_offset),
                   frame_data.begin() + (hi - it->decompressed_offset));
    }

    if (out.size() != length) {
        throw SeekableIndexError("index does not cover the requested range");
    }
    return out;
}

}  // namespace dataeng
