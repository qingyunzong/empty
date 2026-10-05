#pragma once

// Independent reference checker for the idx64 format, using
// arbitrary-precision arithmetic (BigUint) for every boundary
// computation. Used to cross-validate the production library, which
// works directly on checked uint64 arithmetic.
//
// Semantics intentionally mirror idx64::Index::parse:
//   * half-open intervals [offset, offset+length)
//   * identical segments may be shared; any other intersection is a
//     partial overlap
//   * zero-length segments occupy no bytes and never overlap
//   * error precedence: header, table size, per-record bounds (in
//     record order), then overlap

#include "biguint.hpp"
#include "idx64/index.hpp"

#include <cstring>
#include <optional>
#include <vector>

namespace ref {

inline std::uint64_t load_u64le(const std::byte* p) {
    std::uint64_t v = 0;
    for (unsigned i = 0; i < 8; ++i)
        v |= static_cast<std::uint64_t>(std::to_integer<unsigned char>(p[i]))
             << (8 * i);
    return v;
}

// Returns nullopt when the file is a valid index, otherwise the error.
inline std::optional<idx64::Error>
reference_parse(std::span<const std::byte> file) {
    using idx64::Error;
    const BigUint kU64Max = BigUint::from_u64(UINT64_MAX);

    if (file.size() < idx64::kHeaderSize)
        return Error::TruncatedHeader;
    if (std::memcmp(file.data(), idx64::kMagic.data(), idx64::kMagic.size()) != 0)
        return Error::BadMagic;

    const std::uint64_t count = load_u64le(file.data() + 8);

    // needed = count * 16 + 16, computed in arbitrary precision.
    BigUint needed = BigUint::from_u64(count);
    needed.mul_u64(idx64::kRecordSize);
    needed.add_u64(idx64::kHeaderSize);
    if (needed > kU64Max)
        return Error::TableSizeOverflow;
    if (needed > BigUint::from_u64(static_cast<std::uint64_t>(file.size())))
        return Error::TruncatedTable;

    struct Interval {
        BigUint start;
        BigUint end;
        std::uint64_t offset;
        std::uint64_t length;
    };
    std::vector<Interval> ivs;
    const std::byte* p = file.data() + idx64::kHeaderSize;
    for (std::uint64_t i = 0; i < count; ++i, p += idx64::kRecordSize) {
        const std::uint64_t offset = load_u64le(p);
        const std::uint64_t length = load_u64le(p + 8);
        BigUint end = BigUint::from_u64(offset);
        end.add_u64(length); // arbitrary precision: cannot wrap
        if (end > kU64Max)
            return Error::OffsetOverflow;
        if (end > BigUint::from_u64(static_cast<std::uint64_t>(file.size())))
            return Error::SegmentOutOfFile;
        ivs.push_back({BigUint::from_u64(offset), end, offset, length});
    }

    // Pairwise half-open intersection over non-empty segments.
    for (std::size_t i = 0; i < ivs.size(); ++i) {
        for (std::size_t j = i + 1; j < ivs.size(); ++j) {
            const auto& a = ivs[i];
            const auto& b = ivs[j];
            if (a.length == 0 || b.length == 0)
                continue;
            if (a.offset == b.offset && a.length == b.length)
                continue; // shared
            // overlap iff a.start < b.end && b.start < a.end
            if (a.start.compare(b.end) < 0 && b.start.compare(a.end) < 0)
                return Error::PartialOverlap;
        }
    }
    return std::nullopt;
}

} // namespace ref
