#pragma once

// binidx: binary index of 64-bit (offset, length) segments.
//
// On-disk format (all integers little-endian):
//   offset 0  : u64 magic = "BINIDX01"
//   offset 8  : u64 count = number of entries
//   offset 16 : count * { u64 offset, u64 length }
//
// Rules enforced by this library:
//  * Boundary math is overflow-safe: a segment is only valid if
//    offset + length fits in 64 bits (end is exclusive).
//  * Segments may be shared (byte-identical ranges) but must never
//    partially overlap. Zero-length segments are empty intervals and
//    never overlap anything.
//  * A read-only View can only be created for a segment that lies
//    fully inside the backing file.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <variant>
#include <vector>

namespace binidx {

inline constexpr std::uint64_t kMagic = 0x31305844494E4942ULL;  // "BINIDX01"
inline constexpr std::size_t kHeaderSize = 16;                  // magic + count
inline constexpr std::size_t kEntrySize = 16;                   // offset + length

struct Segment {
  std::uint64_t offset = 0;
  std::uint64_t length = 0;
  constexpr auto operator<=>(const Segment&) const = default;
};

enum class Errc {
  kOk,
  kIoError,
  kBadMagic,
  kTruncatedHeader,
  kTruncatedEntries,
  kTrailingBytes,
  kSegmentOverflow,   // offset + length exceeds 2^64 - 1
  kPartialOverlap,    // segments intersect without being identical
  kViewExceedsFile,   // segment range lies outside the file
};

const char* to_string(Errc code);

struct Error {
  Errc code = Errc::kOk;
  std::string message;
};

// Minimal C++20 stand-in for std::expected.
template <typename T>
class Expected {
 public:
  Expected(const T& value) : value_(value) {}
  Expected(T&& value) : value_(std::move(value)) {}
  Expected(Error error) : error_(std::move(error)) {}

  bool has_value() const { return value_.has_value(); }
  explicit operator bool() const { return has_value(); }
  T& value() { return *value_; }
  const T& value() const { return *value_; }
  const Error& error() const { return error_; }

 private:
  std::optional<T> value_;
  Error error_{};
};

// Exclusive end of a segment. Returns false if offset + length would
// overflow 64 bits; `end` is left untouched in that case.
bool segment_end(const Segment& seg, std::uint64_t& end);

// Parses a complete in-memory index image.
Expected<std::vector<Segment>> parse_index(std::span<const std::byte> bytes);

// Checks per-segment overflow and the sharing/overlap rules.
std::optional<Error> validate_layout(const std::vector<Segment>& segments);

// Checks that every segment lies fully within [0, file_size).
std::optional<Error> validate_against_file(const std::vector<Segment>& segments,
                                           std::uint64_t file_size);

// Read-only view over a segment of a file. The caller keeps the file
// buffer alive for the view's lifetime.
class View {
 public:
  View(const std::byte* data, std::size_t size) : data_(data), size_(size) {}

  const std::byte* data() const { return data_; }
  std::size_t size() const { return size_; }
  std::span<const std::byte> span() const { return {data_, size_}; }

  std::byte operator[](std::size_t pos) const { return data_[pos]; }  // unchecked
  std::byte at(std::size_t pos) const;  // throws std::out_of_range

 private:
  const std::byte* data_;
  std::size_t size_;
};

// Returns std::nullopt if the segment does not lie fully inside `file`.
std::optional<View> make_view(const Segment& seg, std::span<const std::byte> file);

// Serialization helpers (shared by the fixture generator and tests).
void append_u64_le(std::vector<std::byte>& out, std::uint64_t value);
std::vector<std::byte> serialize_index(const std::vector<Segment>& segments);

}  // namespace binidx
