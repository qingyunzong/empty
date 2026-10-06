#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "format.hpp"

namespace col {

enum class CmpOp { Eq, Ne, Lt, Le, Gt, Ge };

struct AggResult {
  uint64_t rows = 0;      // total rows, nulls included
  uint64_t non_null = 0;  // rows participating in sum
  __int128 sum = 0;       // sum over non-null values
};

// Encode a logical column (null = std::nullopt) into the columnar file
// format, splitting into blocks of at most max_block_rows rows. Each block
// uses RLE or bit-packed encoding, whichever is smaller, unless
// force_encoding (kEncRle / kEncBitpack) is given.
std::vector<uint8_t> encode_column(const std::vector<std::optional<int64_t>>& rows,
                                   uint64_t max_block_rows = 4096,
                                   std::optional<uint8_t> force_encoding = std::nullopt);

// Aggregate directly on encoded blocks. Throws ColumnError on any corrupt
// block; no partial result is produced in that case.
AggResult aggregate(const uint8_t* data, size_t size);

// Return 0-based positions (original row numbers) of non-null rows whose
// value satisfies `op` against `rhs`. Nulls never match.
std::vector<uint64_t> filter_positions(const uint8_t* data, size_t size, CmpOp op,
                                       int64_t rhs);

std::string to_string_i128(__int128 v);
bool parse_op(const std::string& s, CmpOp& out);

}  // namespace col
