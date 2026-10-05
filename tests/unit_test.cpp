// Unit tests for the idx64 library: boundary arithmetic, overflow
// extremes, truncation, sharing vs. partial overlap, and read-only
// view bounds.

#include "idx64/index.hpp"

#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__,     \
                         #cond);                                             \
            ++failures;                                                      \
        }                                                                    \
    } while (0)

void put_u64le(std::vector<std::byte>& out, std::uint64_t v) {
    for (unsigned i = 0; i < 8; ++i)
        out.push_back(static_cast<std::byte>((v >> (8 * i)) & 0xff));
}

struct Builder {
    std::vector<std::byte> bytes;
    Builder& header(std::uint64_t count) {
        for (char c : idx64::kMagic)
            bytes.push_back(static_cast<std::byte>(c));
        put_u64le(bytes, count);
        return *this;
    }
    Builder& record(std::uint64_t offset, std::uint64_t length) {
        put_u64le(bytes, offset);
        put_u64le(bytes, length);
        return *this;
    }
    Builder& payload(std::size_t n) {
        for (std::size_t i = 0; i < n; ++i)
            bytes.push_back(std::byte{0});
        return *this;
    }
};

using idx64::Error;

void test_checked_end() {
    constexpr std::uint64_t M = UINT64_MAX;
    CHECK(idx64::checked_end(0, 0) == 0);
    CHECK(idx64::checked_end(M, 0) == M);
    CHECK(idx64::checked_end(M - 1, 1) == M);
    CHECK(idx64::checked_end(0, M) == M);
    CHECK(!idx64::checked_end(M, 1).has_value());
    CHECK(!idx64::checked_end(M, M).has_value());
    CHECK(!idx64::checked_end(M - 1, 2).has_value());
    CHECK(!idx64::checked_end(2, M).has_value());
}

void test_header_and_table() {
    // Empty file and short files.
    CHECK(idx64::Index::parse({}).error() == Error::TruncatedHeader);
    {
        Builder b;
        b.header(0);
        b.bytes.resize(15);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::TruncatedHeader);
    }
    // Bad magic.
    {
        Builder b;
        b.header(0);
        b.bytes[3] = std::byte{'X'};
        CHECK(idx64::Index::parse(b.bytes).error() == Error::BadMagic);
    }
    // Empty index is valid.
    {
        Builder b;
        b.header(0);
        auto r = idx64::Index::parse(b.bytes);
        CHECK(r.has_value());
        CHECK(r && r->segments().empty());
    }
    // count * 16 + 16 overflows uint64.
    {
        Builder b;
        b.header(UINT64_MAX);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::TableSizeOverflow);
    }
    // Largest representable count still cannot fit in a real file.
    {
        Builder b;
        b.header((UINT64_MAX - 16) / 16);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::TruncatedTable);
    }
    // Table shorter than declared.
    {
        Builder b;
        b.header(2).record(0, 0);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::TruncatedTable);
    }
    // Trailing bytes after the table are fine (they are payload).
    {
        Builder b;
        b.header(0).payload(100);
        auto r = idx64::Index::parse(b.bytes);
        CHECK(r.has_value());
    }
}

void test_segment_bounds() {
    constexpr std::uint64_t M = UINT64_MAX;
    // offset + length overflows.
    {
        Builder b;
        b.header(1).record(M, 1).payload(8);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::OffsetOverflow);
    }
    // end == UINT64_MAX exactly: no overflow, but beyond any real file.
    {
        Builder b;
        b.header(1).record(M, 0).payload(8);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::SegmentOutOfFile);
    }
    {
        Builder b;
        b.header(1).record(M - 3, 3).payload(8);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::SegmentOutOfFile);
    }
    // end == file size exactly: valid boundary.
    {
        Builder b;
        b.header(1).record(16, 16); // file = 16 + 16 = 32, end = 32
        auto r = idx64::Index::parse(b.bytes);
        CHECK(r.has_value());
    }
    // end == file size - 1 vs file size: off-by-one beyond file.
    {
        Builder b;
        b.header(1).record(16, 17); // file = 32, end = 33
        CHECK(idx64::Index::parse(b.bytes).error() == Error::SegmentOutOfFile);
    }
    // Zero-length segment exactly at end of file: valid.
    {
        Builder b;
        b.header(1).record(32, 0);
        auto r = idx64::Index::parse(b.bytes);
        CHECK(r.has_value());
    }
}

void test_overlap_rules() {
    // Identical segments: shared, allowed.
    {
        Builder b;
        b.header(2).record(32, 8).record(32, 8).payload(8);
        auto r = idx64::Index::parse(b.bytes);
        CHECK(r.has_value());
    }
    // Touching half-open intervals: allowed.
    {
        Builder b;
        b.header(2).record(32, 8).record(40, 8).payload(16);
        auto r = idx64::Index::parse(b.bytes);
        CHECK(r.has_value());
    }
    // Partial overlap.
    {
        Builder b;
        b.header(2).record(32, 8).record(39, 8).payload(16);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::PartialOverlap);
    }
    // Same start, different length: partial overlap.
    {
        Builder b;
        b.header(2).record(32, 8).record(32, 4).payload(16);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::PartialOverlap);
    }
    // Nested: partial overlap.
    {
        Builder b;
        b.header(2).record(32, 16).record(36, 4).payload(16);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::PartialOverlap);
    }
    // Overlap detected regardless of record order.
    {
        Builder b;
        b.header(2).record(39, 8).record(32, 8).payload(16);
        CHECK(idx64::Index::parse(b.bytes).error() == Error::PartialOverlap);
    }
    // Zero-length segment inside another: occupies no bytes, allowed.
    {
        Builder b;
        b.header(2).record(32, 16).record(40, 0).payload(16);
        auto r = idx64::Index::parse(b.bytes);
        CHECK(r.has_value());
    }
    // Three segments, shared pair plus a disjoint one.
    {
        Builder b;
        b.header(3).record(32, 8).record(32, 8).record(44, 4).payload(16);
        auto r = idx64::Index::parse(b.bytes);
        CHECK(r.has_value());
    }
}

void test_segment_view() {
    Builder b;
    b.header(2).record(32, 8).record(48, 0).payload(16); // file = 64 bytes
    auto r = idx64::Index::parse(b.bytes);
    CHECK(r.has_value());
    if (!r)
        return;
    // In-bounds view.
    auto v0 = r->segment_view(b.bytes, 0);
    CHECK(v0.has_value());
    CHECK(v0 && v0->size() == 8);
    CHECK(v0 && v0->data() == b.bytes.data() + 32);
    // Zero-length view at end of file.
    auto v1 = r->segment_view(b.bytes, 1);
    CHECK(v1.has_value());
    CHECK(v1 && v1->empty());
    // Out-of-range index.
    CHECK(!r->segment_view(b.bytes, 2).has_value());
    // View against a file smaller than the validated one: refused.
    std::vector<std::byte> shorter(b.bytes.begin(), b.bytes.begin() + 40);
    CHECK(!r->segment_view(shorter, 0).has_value());
}

} // namespace

int main() {
    test_checked_end();
    test_header_and_table();
    test_segment_bounds();
    test_overlap_rules();
    test_segment_view();
    if (failures != 0) {
        std::fprintf(stderr, "%d check(s) failed\n", failures);
        return EXIT_FAILURE;
    }
    std::printf("all unit checks passed\n");
    return EXIT_SUCCESS;
}
