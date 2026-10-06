#pragma once

#include <cstdint>
#include <iosfwd>
#include <stdexcept>
#include <string>
#include <vector>

namespace columnar {

// Comparison operators supported by filter / filtered aggregation.
enum class CmpOp { Eq, Ne, Lt, Le, Gt, Ge };

// Thrown on any malformed input. Readers validate the whole column before
// returning, so a corrupt block never yields partial results.
struct Error : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct Run {
    bool is_null;
    int64_t value;   // ignored when is_null
    uint32_t length; // >= 1
};

struct Block {
    enum class Enc : uint8_t { Rle = 1, BitPack = 2 };
    Enc enc = Enc::Rle;
    uint32_t rows = 0;
    // RLE payload.
    std::vector<Run> runs;
    // BitPack payload: null_bitmap bit i set => row i is null; packed holds
    // rows * bit_width bits, two's-complement signed values, LSB-first.
    uint8_t bit_width = 0;
    std::vector<uint8_t> null_bitmap;
    std::vector<uint8_t> packed;
};

struct Column {
    std::string name;
    uint64_t num_rows = 0;
    std::vector<Block> blocks;
};

struct AggResult {
    uint64_t count = 0;   // rows counted (nulls included for full-column agg)
    __int128 sum = 0;     // nulls never contribute
};

// Block construction from raw row data (values[i] ignored when nulls[i]).
Block make_rle_block(const int64_t* values, const bool* nulls, uint32_t n);
Block make_bitpack_block(const int64_t* values, const bool* nulls, uint32_t n);

// Deterministic random column mixing RLE and bit-packed blocks (CLI + tests).
Column generate_column(uint64_t rows, uint64_t seed);

// Serialization. read_column validates sizes, run-length sums, bit widths and
// rejects trailing garbage; any violation throws Error.
void write_column(std::ostream& out, const Column& col);
Column read_column(std::istream& in);

// Full decode, intended for the row-by-row reference in tests.
void decode(const Column& col, std::vector<int64_t>& values, std::vector<bool>& nulls);

// Queries operate directly on encoded blocks (no full decode).
// filter_positions returns original row numbers, ascending.
std::vector<uint64_t> filter_positions(const Column& col, CmpOp op, int64_t v);
// Full-column aggregate: count = total rows (nulls counted), sum skips nulls.
AggResult aggregate(const Column& col);
// Filtered aggregate over rows matching cmp(row, v); nulls never match.
AggResult aggregate(const Column& col, CmpOp op, int64_t v);

CmpOp parse_op(const std::string& s);
std::string to_string_i128(__int128 v);

} // namespace columnar
