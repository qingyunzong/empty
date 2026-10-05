#include "binidx/binidx.hpp"

#include <algorithm>
#include <cstdio>
#include <stdexcept>

namespace binidx {

const char* to_string(Errc code) {
  switch (code) {
    case Errc::kOk: return "OK";
    case Errc::kIoError: return "IO_ERROR";
    case Errc::kBadMagic: return "BAD_MAGIC";
    case Errc::kTruncatedHeader: return "TRUNCATED_HEADER";
    case Errc::kTruncatedEntries: return "TRUNCATED_ENTRIES";
    case Errc::kTrailingBytes: return "TRAILING_BYTES";
    case Errc::kSegmentOverflow: return "SEGMENT_OVERFLOW";
    case Errc::kPartialOverlap: return "PARTIAL_OVERLAP";
    case Errc::kViewExceedsFile: return "VIEW_EXCEEDS_FILE";
  }
  return "UNKNOWN";
}

static std::uint64_t read_u64_le(const std::byte* p) {
  std::uint64_t v = 0;
  for (int i = 0; i < 8; ++i) v |= std::to_integer<std::uint64_t>(p[i]) << (8 * i);
  return v;
}

void append_u64_le(std::vector<std::byte>& out, std::uint64_t value) {
  for (int i = 0; i < 8; ++i) out.push_back(static_cast<std::byte>((value >> (8 * i)) & 0xFF));
}

std::vector<std::byte> serialize_index(const std::vector<Segment>& segments) {
  std::vector<std::byte> out;
  out.reserve(kHeaderSize + segments.size() * kEntrySize);
  append_u64_le(out, kMagic);
  append_u64_le(out, static_cast<std::uint64_t>(segments.size()));
  for (const auto& seg : segments) {
    append_u64_le(out, seg.offset);
    append_u64_le(out, seg.length);
  }
  return out;
}

bool segment_end(const Segment& seg, std::uint64_t& end) {
  // Overflow-safe: offset + length <= 2^64 - 1  <=>  length <= MAX - offset.
  if (seg.length > UINT64_MAX - seg.offset) return false;
  end = seg.offset + seg.length;
  return true;
}

Expected<std::vector<Segment>> parse_index(std::span<const std::byte> bytes) {
  if (bytes.size() < 8) {
    return Error{Errc::kTruncatedHeader, "index shorter than 8-byte magic"};
  }
  if (read_u64_le(bytes.data()) != kMagic) {
    return Error{Errc::kBadMagic, "bad magic, not a BINIDX01 index"};
  }
  if (bytes.size() < kHeaderSize) {
    return Error{Errc::kTruncatedHeader, "index shorter than 16-byte header"};
  }
  const std::uint64_t count = read_u64_le(bytes.data() + 8);
  // Checked size computation: required = 16 + count * 16, no overflow.
  if (count > (UINT64_MAX - kHeaderSize) / kEntrySize) {
    return Error{Errc::kTruncatedEntries, "entry count overflows addressable size"};
  }
  const std::uint64_t required = kHeaderSize + count * kEntrySize;
  const std::uint64_t actual = static_cast<std::uint64_t>(bytes.size());
  if (actual < required) {
    return Error{Errc::kTruncatedEntries, "index truncated: " + std::to_string(actual) +
                                              " of " + std::to_string(required) + " bytes"};
  }
  if (actual > required) {
    return Error{Errc::kTrailingBytes, std::to_string(actual - required) +
                                           " trailing byte(s) after last entry"};
  }
  std::vector<Segment> segments;
  segments.reserve(static_cast<std::size_t>(count));
  const std::byte* p = bytes.data() + kHeaderSize;
  for (std::uint64_t i = 0; i < count; ++i, p += kEntrySize) {
    segments.push_back(Segment{read_u64_le(p), read_u64_le(p + 8)});
  }
  return segments;
}

std::optional<Error> validate_layout(const std::vector<Segment>& segments) {
  struct Item {
    Segment seg;
    std::size_t index;
    std::uint64_t end;  // exclusive
  };
  std::vector<Item> items;
  items.reserve(segments.size());
  for (std::size_t i = 0; i < segments.size(); ++i) {
    std::uint64_t end = 0;
    if (!segment_end(segments[i], end)) {
      return Error{Errc::kSegmentOverflow, "segment[" + std::to_string(i) +
                                               "] offset+length overflows 64 bits"};
    }
    items.push_back(Item{segments[i], i, end});
  }
  std::sort(items.begin(), items.end(),
            [](const Item& a, const Item& b) { return a.seg < b.seg; });

  // Sweep: identical ranges (sharing) are fine; any other intersection
  // between non-empty ranges is a partial overlap. Zero-length ranges are
  // empty intervals and can never intersect anything.
  bool have_anchor = false;
  Item anchor{};
  for (const Item& it : items) {
    if (it.seg.length == 0) continue;
    if (have_anchor && it.seg.offset < anchor.end) {
      if (it.seg == anchor.seg) continue;  // shared range, allowed
      return Error{Errc::kPartialOverlap,
                   "segment[" + std::to_string(anchor.index) + "] and segment[" +
                       std::to_string(it.index) + "] partially overlap"};
    }
    anchor = it;
    have_anchor = true;
  }
  return std::nullopt;
}

std::optional<Error> validate_against_file(const std::vector<Segment>& segments,
                                           std::uint64_t file_size) {
  for (std::size_t i = 0; i < segments.size(); ++i) {
    const Segment& seg = segments[i];
    // Both comparisons are overflow-free: the second only runs when
    // seg.offset <= file_size, so file_size - seg.offset cannot wrap.
    if (seg.offset > file_size || seg.length > file_size - seg.offset) {
      return Error{Errc::kViewExceedsFile,
                   "segment[" + std::to_string(i) + "] (offset=" + std::to_string(seg.offset) +
                       ", length=" + std::to_string(seg.length) + ") exceeds file size " +
                       std::to_string(file_size)};
    }
  }
  return std::nullopt;
}

std::optional<View> make_view(const Segment& seg, std::span<const std::byte> file) {
  const std::uint64_t size = static_cast<std::uint64_t>(file.size());
  if (seg.offset > size || seg.length > size - seg.offset) return std::nullopt;
  return View(file.data() + static_cast<std::size_t>(seg.offset),
              static_cast<std::size_t>(seg.length));
}

std::byte View::at(std::size_t pos) const {
  if (pos >= size_) {
    throw std::out_of_range("binidx::View::at(" + std::to_string(pos) +
                            ") with size " + std::to_string(size_));
  }
  return data_[pos];
}

}  // namespace binidx
