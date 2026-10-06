// Randomized differential test: encoded-block queries vs row-by-row reference.
#include "columnar/blocks.hpp"

#include <iostream>
#include <random>
#include <sstream>

using namespace columnar;

static int failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " " #cond   \
                      << "\n";                                                 \
            ++failures;                                                        \
        }                                                                      \
    } while (0)

static bool ref_cmp(CmpOp op, int64_t a, int64_t b) {
    switch (op) {
    case CmpOp::Eq: return a == b;
    case CmpOp::Ne: return a != b;
    case CmpOp::Lt: return a < b;
    case CmpOp::Le: return a <= b;
    case CmpOp::Gt: return a > b;
    case CmpOp::Ge: return a >= b;
    }
    return false;
}

static void expect_error(const char* what, void (*fn)(void*), void* ctx) {
    try {
        fn(ctx);
        std::cerr << "FAIL expected columnar::Error: " << what << "\n";
        ++failures;
    } catch (const Error&) {
    }
}

static Column roundtrip(const Column& col) {
    std::stringstream ss;
    write_column(ss, col);
    return read_column(ss);
}

static void test_random_roundtrip_and_queries() {
    static const CmpOp ops[] = {CmpOp::Eq, CmpOp::Ne, CmpOp::Lt,
                                CmpOp::Le, CmpOp::Gt, CmpOp::Ge};
    for (uint64_t seed = 0; seed < 100; ++seed) {
        uint64_t rows = 1 + seed * 37 % 3000;
        Column col = generate_column(rows, seed);
        Column back = roundtrip(col);
        CHECK(back.num_rows == rows);

        std::vector<int64_t> values;
        std::vector<bool> nulls;
        decode(back, values, nulls);
        CHECK(values.size() == rows);

        // Re-decode original in-memory column: must match serialized form.
        std::vector<int64_t> v0;
        std::vector<bool> n0;
        decode(col, v0, n0);
        CHECK(v0 == values);
        CHECK(n0 == nulls);

        std::mt19937_64 rng(seed * 7 + 1);
        for (CmpOp op : ops) {
            int64_t threshold = static_cast<int64_t>(rng() % 4001) - 2000;
            std::vector<uint64_t> got = filter_positions(back, op, threshold);
            std::vector<uint64_t> want;
            for (uint64_t i = 0; i < rows; ++i)
                if (!nulls[i] && ref_cmp(op, values[i], threshold))
                    want.push_back(i);
            CHECK(got == want); // positions must be original row numbers

            AggResult g = aggregate(back, op, threshold);
            AggResult w;
            for (uint64_t i = 0; i < rows; ++i)
                if (!nulls[i] && ref_cmp(op, values[i], threshold)) {
                    ++w.count;
                    w.sum += values[i];
                }
            CHECK(g.count == w.count);
            CHECK(g.sum == w.sum);
        }

        AggResult g = aggregate(back);
        __int128 want_sum = 0;
        uint64_t non_null = 0;
        for (uint64_t i = 0; i < rows; ++i)
            if (!nulls[i]) {
                want_sum += values[i];
                ++non_null;
            }
        CHECK(g.count == rows); // nulls count toward total rows
        CHECK(g.sum == want_sum); // ... but never toward the sum
        (void)non_null;
    }
}

static void test_empty_column() {
    Column col;
    col.name = "empty";
    col.num_rows = 0;
    Column back = roundtrip(col);
    CHECK(back.num_rows == 0);
    CHECK(back.blocks.empty());
    AggResult r = aggregate(back);
    CHECK(r.count == 0);
    CHECK(r.sum == 0);
    CHECK(filter_positions(back, CmpOp::Eq, 5).empty());
}

static void test_error_blocks_no_partial_results() {
    // A valid first block followed by a corrupt second block: the reader
    // must fail the whole column instead of returning block 1's data.
    Column col = generate_column(500, 123);
    CHECK(col.blocks.size() >= 1);
    {
        Column bad = col;
        Block extra;
        extra.enc = Block::Enc::Rle;
        extra.rows = 10;
        extra.runs.push_back(Run{false, 7, 4}); // sums to 4, not 10
        bad.blocks.push_back(extra);
        bad.num_rows += 10;
        std::stringstream ss;
        write_column(ss, bad);
        expect_error("run lengths do not sum to block rows",
                     [](void* p) { read_column(*static_cast<std::stringstream*>(p)); }, &ss);
    }
    {
        std::stringstream ss;
        write_column(ss, col);
        std::string bytes = ss.str();
        bytes[0] = 'X'; // corrupt magic
        std::stringstream in(bytes);
        expect_error("bad magic",
                     [](void* p) { read_column(*static_cast<std::stringstream*>(p)); }, &in);
    }
    {
        std::stringstream ss;
        write_column(ss, col);
        std::string bytes = ss.str();
        bytes.resize(bytes.size() / 2); // truncate
        std::stringstream in(bytes);
        expect_error("truncated",
                     [](void* p) { read_column(*static_cast<std::stringstream*>(p)); }, &in);
    }
    {
        std::stringstream ss;
        write_column(ss, col);
        std::string bytes = ss.str();
        bytes.push_back('\x00'); // trailing garbage
        std::stringstream in(bytes);
        expect_error("trailing bytes",
                     [](void* p) { read_column(*static_cast<std::stringstream*>(p)); }, &in);
    }
    {
        Column bad;
        bad.name = "w";
        bad.num_rows = 4;
        Block b;
        b.enc = Block::Enc::BitPack;
        b.rows = 4;
        b.bit_width = 0; // invalid
        b.null_bitmap.assign(1, 0);
        bad.blocks.push_back(b);
        std::stringstream ss;
        write_column(ss, bad);
        expect_error("invalid bit width",
                     [](void* p) { read_column(*static_cast<std::stringstream*>(p)); }, &ss);
    }
    {
        Column bad;
        bad.name = "n";
        bad.num_rows = 8;
        Block b;
        b.enc = Block::Enc::BitPack;
        b.rows = 8;
        b.bit_width = 3;
        b.null_bitmap.assign(1, 0);
        b.packed.assign(3, 0); // expected (8*3+7)/8 = 3, ok
        bad.blocks.push_back(b);
        bad.blocks.push_back(b); // 16 rows != num_rows 8
        std::stringstream ss;
        write_column(ss, bad);
        expect_error("block rows exceed column rows",
                     [](void* p) { read_column(*static_cast<std::stringstream*>(p)); }, &ss);
    }
}

static void test_extremes() {
    // Force 64-bit-wide bit-packing and RLE with INT64_MIN/MAX.
    int64_t vals[] = {INT64_MIN, INT64_MAX, 0, -1, 1, INT64_MIN, INT64_MAX};
    bool nulls[] = {false, false, true, false, false, false, true};
    Column col;
    col.name = "x";
    col.num_rows = 7;
    col.blocks.push_back(make_bitpack_block(vals, nulls, 7));
    col.blocks.push_back(make_rle_block(vals, nulls, 7));
    col.num_rows = 14;
    Column back = roundtrip(col);

    std::vector<int64_t> dv;
    std::vector<bool> dn;
    decode(back, dv, dn);
    for (int rep = 0; rep < 2; ++rep)
        for (int i = 0; i < 7; ++i) {
            CHECK(dn[rep * 7 + i] == nulls[i]);
            if (!nulls[i])
                CHECK(dv[rep * 7 + i] == vals[i]);
        }

    auto pos = filter_positions(back, CmpOp::Eq, INT64_MIN);
    CHECK((pos == std::vector<uint64_t>{0, 5, 7, 12}));
    AggResult r = aggregate(back);
    CHECK(r.count == 14);
    CHECK(r.sum == __int128(2) * (2 * __int128(INT64_MIN) + __int128(INT64_MAX)));
}

int main() {
    test_random_roundtrip_and_queries();
    test_empty_column();
    test_error_blocks_no_partial_results();
    test_extremes();
    if (failures) {
        std::cerr << failures << " failure(s)\n";
        return 1;
    }
    std::cout << "all engine tests passed\n";
    return 0;
}
