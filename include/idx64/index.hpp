#pragma once

// idx64: read-only parser/validator for a binary segment index with 64-bit
// offsets and lengths.
//
// On-disk format (little-endian):
//   bytes  [0, 8)   magic "IDX64V1\0"
//   bytes  [8, 16)  uint64 count
//   bytes [16, ...) count records of { uint64 offset, uint64 length }
//
// Validation rules:
//   * offset + length is computed with overflow-checked arithmetic.
//   * Every segment must lie within the file: offset + length <= file size.
//   * Segments are half-open intervals [offset, offset+length). Identical
//     segments may be shared; partially overlapping segments are rejected.
//   * Zero-length segments occupy no bytes and never count as overlapping.
//   * The parser never reads beyond the supplied file view.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace idx64 {

inline constexpr std::size_t kHeaderSize = 16;
inline constexpr std::size_t kRecordSize = 16;
inline constexpr std::string_view kMagic{"IDX64V1\0", 8};

enum class Error {
    BadMagic,
    TruncatedHeader,
    TableSizeOverflow,
    TruncatedTable,
    OffsetOverflow,
    SegmentOutOfFile,
    PartialOverlap,
};

std::string_view to_string(Error e) noexcept;

struct Segment {
    std::uint64_t offset;
    std::uint64_t length;
};

// Overflow-safe end computation: returns nullopt iff offset + length
// does not fit in a uint64.
std::optional<std::uint64_t> checked_end(std::uint64_t offset,
                                         std::uint64_t length) noexcept;

// Minimal expected-like result type (std::expected is C++23).
template <typename T>
class Result {
public:
    Result(T value) : data_(std::move(value)) {}
    Result(Error e) : data_(e) {} // NOLINT: intentionally implicit

    bool has_value() const noexcept { return std::holds_alternative<T>(data_); }
    explicit operator bool() const noexcept { return has_value(); }

    T& operator*() & { return std::get<T>(data_); }
    const T& operator*() const& { return std::get<T>(data_); }
    T* operator->() { return &std::get<T>(data_); }
    const T* operator->() const { return &std::get<T>(data_); }

    Error error() const { return std::get<Error>(data_); }

private:
    std::variant<T, Error> data_;
};

class Index {
public:
    // Parses and validates an index over the given read-only file view.
    // The view itself must cover exactly the file; nothing past
    // file.size() is ever touched.
    static Result<Index> parse(std::span<const std::byte> file);

    std::span<const Segment> segments() const noexcept { return segments_; }
    std::uint64_t file_size() const noexcept { return file_size_; }

    // Read-only view of segment i's bytes inside `file`. Guaranteed to lie
    // within the file; returns nullopt if i is out of range or `file` is
    // smaller than the file the index was validated against.
    std::optional<std::span<const std::byte>>
    segment_view(std::span<const std::byte> file, std::size_t i) const noexcept;

private:
    std::vector<Segment> segments_;
    std::uint64_t file_size_ = 0;
};

} // namespace idx64
