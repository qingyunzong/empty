#include "idx64/index.hpp"

#include <algorithm>
#include <cstring>

namespace idx64 {

namespace {

std::uint64_t load_u64le(const std::byte* p) noexcept {
    std::uint64_t v = 0;
    for (unsigned i = 0; i < 8; ++i)
        v |= static_cast<std::uint64_t>(std::to_integer<unsigned char>(p[i]))
             << (8 * i);
    return v;
}

} // namespace

std::string_view to_string(Error e) noexcept {
    switch (e) {
    case Error::BadMagic: return "bad magic";
    case Error::TruncatedHeader: return "truncated header";
    case Error::TableSizeOverflow: return "record table size overflows 64 bits";
    case Error::TruncatedTable: return "record table truncated";
    case Error::OffsetOverflow: return "offset + length overflows 64 bits";
    case Error::SegmentOutOfFile: return "segment extends past end of file";
    case Error::PartialOverlap: return "segments partially overlap";
    }
    return "unknown error";
}

std::optional<std::uint64_t> checked_end(std::uint64_t offset,
                                         std::uint64_t length) noexcept {
    if (length > UINT64_MAX - offset)
        return std::nullopt;
    return offset + length;
}

Result<Index> Index::parse(std::span<const std::byte> file) {
    if (file.size() < kHeaderSize)
        return Error::TruncatedHeader;
    if (std::memcmp(file.data(), kMagic.data(), kMagic.size()) != 0)
        return Error::BadMagic;

    const std::uint64_t count = load_u64le(file.data() + 8);
    // count * kRecordSize + kHeaderSize must not overflow uint64.
    if (count > (UINT64_MAX - kHeaderSize) / kRecordSize)
        return Error::TableSizeOverflow;
    const std::uint64_t table_bytes = count * kRecordSize;
    if (table_bytes > static_cast<std::uint64_t>(file.size()) - kHeaderSize)
        return Error::TruncatedTable;

    Index idx;
    idx.file_size_ = static_cast<std::uint64_t>(file.size());
    idx.segments_.reserve(static_cast<std::size_t>(count));

    const std::byte* p = file.data() + kHeaderSize;
    for (std::uint64_t i = 0; i < count; ++i, p += kRecordSize) {
        Segment s{load_u64le(p), load_u64le(p + 8)};
        const auto end = checked_end(s.offset, s.length);
        if (!end)
            return Error::OffsetOverflow;
        if (*end > idx.file_size_)
            return Error::SegmentOutOfFile;
        idx.segments_.push_back(s);
    }

    // Partial-overlap check on the non-empty segments, sorted by
    // (offset, length). Identical segments are shared and allowed; any
    // other intersection is a partial overlap.
    std::vector<Segment> sorted;
    sorted.reserve(idx.segments_.size());
    for (const auto& s : idx.segments_)
        if (s.length != 0)
            sorted.push_back(s);
    std::sort(sorted.begin(), sorted.end(), [](const Segment& a, const Segment& b) {
        return a.offset < b.offset ||
               (a.offset == b.offset && a.length < b.length);
    });
    for (std::size_t i = 1; i < sorted.size(); ++i) {
        const Segment& prev = sorted[i - 1];
        const Segment& cur = sorted[i];
        if (prev.offset == cur.offset && prev.length == cur.length)
            continue; // shared segment
        // prev.offset + prev.length cannot overflow: validated above.
        if (prev.offset + prev.length > cur.offset)
            return Error::PartialOverlap;
    }

    return idx;
}

std::optional<std::span<const std::byte>>
Index::segment_view(std::span<const std::byte> file, std::size_t i) const noexcept {
    if (i >= segments_.size())
        return std::nullopt;
    if (static_cast<std::uint64_t>(file.size()) < file_size_)
        return std::nullopt;
    const Segment& s = segments_[i];
    // offset + length <= file_size_ <= file.size(), so this never
    // exceeds the file view.
    return file.subspan(static_cast<std::size_t>(s.offset),
                        static_cast<std::size_t>(s.length));
}

} // namespace idx64
