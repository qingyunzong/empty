#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <stdexcept>
#include <vector>

namespace dataeng {

// Thrown when the seek table or the underlying frames fail validation.
// A corrupt index is always an error; the library never falls back to
// an unbounded scan of the file.
class SeekableIndexError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Thrown when a requested decompressed range lies outside the contents.
class SeekableRangeError : public std::out_of_range {
public:
    using std::out_of_range::out_of_range;
};

struct SeekFrameEntry {
    std::uint64_t compressed_offset = 0;
    std::uint64_t decompressed_offset = 0;
    std::uint32_t compressed_size = 0;
    std::uint32_t decompressed_size = 0;
    std::optional<std::uint32_t> checksum;
};

// Parsed and fully validated seek table of a seekable Zstandard file.
//
// Validation performed by parse():
//  - the last frame is a skippable frame (magic 0x184D2A5E) ending exactly
//    at end of file, holding the seek table;
//  - descriptor reserved bits are clear and the table size matches the
//    declared frame count and checksum flag;
//  - the table carries the 0x8F92EAB1 seekable footer magic;
//  - walking the actual frames from offset 0 yields exactly the declared
//    frames: every entry's compressed size equals the real frame size, so
//    the sum of compressed sizes lands exactly on the seek table offset;
//  - every entry's decompressed size matches the frame content size when
//    the frame header records one;
//  - when the table carries checksums, every frame has its checksum flag
//    set and the entry checksum equals the frame's trailing checksum.
class SeekableIndex {
public:
    static SeekableIndex parse(std::span<const std::byte> file_contents);

    const std::vector<SeekFrameEntry>& entries() const noexcept { return entries_; }
    std::size_t frameCount() const noexcept { return entries_.size(); }
    std::uint64_t compressedSize() const noexcept { return compressed_size_; }
    std::uint64_t decompressedSize() const noexcept { return decompressed_size_; }
    bool hasChecksums() const noexcept { return has_checksums_; }

    // Returns the decompressed bytes in [offset, offset + length).
    // Only the frames intersecting the range are decompressed; frame
    // content checksums are verified by the decoder during decompression.
    std::vector<std::byte> readRange(std::span<const std::byte> file_contents,
                                     std::uint64_t offset,
                                     std::uint64_t length) const;

private:
    std::vector<SeekFrameEntry> entries_;
    std::uint64_t compressed_size_ = 0;
    std::uint64_t decompressed_size_ = 0;
    bool has_checksums_ = false;
};

// Convenience owner of the file bytes plus its validated index.
class SeekableReader {
public:
    explicit SeekableReader(std::vector<std::byte> file_contents)
        : file_(std::move(file_contents)), index_(SeekableIndex::parse(file_)) {}

    const SeekableIndex& index() const noexcept { return index_; }

    std::vector<std::byte> readRange(std::uint64_t offset, std::uint64_t length) const {
        return index_.readRange(file_, offset, length);
    }

private:
    std::vector<std::byte> file_;
    SeekableIndex index_;
};

}  // namespace dataeng
