// Executable unit tests: random encoded columns are filtered/aggregated
// directly on RLE and bit-packed blocks and cross-checked against a naive
// row-by-row reference over the logical values.
#include <cstdint>
#include <iostream>
#include <optional>
#include <random>
#include <string>
#include <vector>

#include "column.hpp"

namespace {

int failures = 0;

#define CHECK(cond)                                                       \
  do {                                                                    \
    if (!(cond)) {                                                        \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " " << #cond \
                << "\n";                                                  \
      ++failures;                                                         \
    }                                                                     \
  } while (0)

bool cmp_op(col::CmpOp op, int64_t a, int64_t b) {
  switch (op) {
    case col::CmpOp::Eq: return a == b;
    case col::CmpOp::Ne: return a != b;
    case col::CmpOp::Lt: return a < b;
    case col::CmpOp::Le: return a <= b;
    case col::CmpOp::Gt: return a > b;
    case col::CmpOp::Ge: return a >= b;
  }
  return false;
}

// Naive row-by-row reference implementation.
struct Reference {
  static col::AggResult agg(const std::vector<std::optional<int64_t>>& rows) {
    col::AggResult r;
    r.rows = rows.size();
    for (const auto& v : rows)
      if (v) {
        ++r.non_null;
        r.sum += *v;
      }
    return r;
  }
  static std::vector<uint64_t> filter(const std::vector<std::optional<int64_t>>& rows,
                                      col::CmpOp op, int64_t rhs) {
    std::vector<uint64_t> out;
    for (size_t i = 0; i < rows.size(); ++i)
      if (rows[i] && cmp_op(op, *rows[i], rhs)) out.push_back(i);
    return out;
  }
};

std::vector<std::optional<int64_t>> gen_rows(std::mt19937_64& rng, size_t len) {
  std::vector<std::optional<int64_t>> rows;
  rows.reserve(len);
  std::optional<int64_t> prev;
  for (size_t i = 0; i < len; ++i) {
    uint64_t roll = rng() % 100;
    if (roll < 25) {
      rows.push_back(std::nullopt);
      prev = std::nullopt;
    } else if (roll < 60 && prev) {
      rows.push_back(prev);  // extend a run
    } else {
      int64_t v;
      switch (rng() % 4) {
        case 0: v = static_cast<int64_t>(rng() % 4); break;          // tiny, run-friendly
        case 1: v = static_cast<int64_t>(rng() % 256) - 128; break;  // small signed
        case 2: v = static_cast<int64_t>(rng() % 2000000) - 1000000; break;
        default: v = static_cast<int64_t>(rng()); break;             // full int64 range
      }
      rows.push_back(v);
      prev = v;
    }
  }
  return rows;
}

void check_against_reference(const std::vector<std::optional<int64_t>>& rows,
                             const std::vector<uint8_t>& buf, std::mt19937_64& rng) {
  col::AggResult got = col::aggregate(buf.data(), buf.size());
  col::AggResult want = Reference::agg(rows);
  CHECK(got.rows == want.rows);
  CHECK(got.non_null == want.non_null);
  CHECK(got.sum == want.sum);

  static const col::CmpOp ops[] = {col::CmpOp::Eq, col::CmpOp::Ne, col::CmpOp::Lt,
                                   col::CmpOp::Le, col::CmpOp::Gt, col::CmpOp::Ge};
  std::vector<int64_t> rhs_values = {0, 1, -1, 127, -128, 1000000, -1000000,
                                     std::numeric_limits<int64_t>::max(),
                                     std::numeric_limits<int64_t>::min()};
  for (const auto& v : rows)
    if (v && rng() % 8 == 0) rhs_values.push_back(*v);
  for (col::CmpOp op : ops)
    for (int64_t rhs : rhs_values) {
      std::vector<uint64_t> got_pos =
          col::filter_positions(buf.data(), buf.size(), op, rhs);
      std::vector<uint64_t> want_pos = Reference::filter(rows, op, rhs);
      CHECK(got_pos == want_pos);
    }
}

int test_random(int trials, uint64_t seed_base) {
  for (int t = 0; t < trials; ++t) {
    std::mt19937_64 rng(seed_base + static_cast<uint64_t>(t));
    size_t len = (t % 7 == 0) ? 0 : static_cast<size_t>(rng() % 3000);
    auto rows = gen_rows(rng, len);
    static const uint64_t block_sizes[] = {1, 2, 7, 64, 1000, 100000};
    uint64_t bs = block_sizes[rng() % 6];
    std::optional<uint8_t> force;
    switch (rng() % 3) {
      case 0: force = std::nullopt; break;
      case 1: force = col::kEncRle; break;
      case 2: force = col::kEncBitpack; break;
    }
    auto buf = col::encode_column(rows, bs, force);
    check_against_reference(rows, buf, rng);
  }
  std::cout << "random: " << trials << " trials done\n";
  return failures;
}

int test_edge() {
  // Empty column.
  {
    auto buf = col::encode_column({}, 16);
    auto r = col::aggregate(buf.data(), buf.size());
    CHECK(r.rows == 0 && r.non_null == 0 && r.sum == 0);
    CHECK(col::filter_positions(buf.data(), buf.size(), col::CmpOp::Eq, 0).empty());
  }
  // All nulls.
  {
    std::vector<std::optional<int64_t>> rows(100, std::nullopt);
    for (uint8_t enc : {col::kEncRle, col::kEncBitpack}) {
      auto buf = col::encode_column(rows, 10, enc);
      auto r = col::aggregate(buf.data(), buf.size());
      CHECK(r.rows == 100 && r.non_null == 0 && r.sum == 0);
      CHECK(col::filter_positions(buf.data(), buf.size(), col::CmpOp::Ne, 5).empty());
    }
  }
  // int64 extremes in one block force 64-bit packing; sum overflows int64
  // and must be exact via __int128.
  {
    std::vector<std::optional<int64_t>> rows = {
        std::numeric_limits<int64_t>::min(), std::numeric_limits<int64_t>::max(),
        std::numeric_limits<int64_t>::max(), std::nullopt, -5};
    for (uint8_t enc : {col::kEncRle, col::kEncBitpack}) {
      auto buf = col::encode_column(rows, 1000, enc);
      auto r = col::aggregate(buf.data(), buf.size());
      __int128 want = static_cast<__int128>(std::numeric_limits<int64_t>::min()) +
                      2 * static_cast<__int128>(std::numeric_limits<int64_t>::max()) - 5;
      CHECK(r.rows == 5 && r.non_null == 4 && r.sum == want);
      auto pos = col::filter_positions(buf.data(), buf.size(), col::CmpOp::Ge,
                                       std::numeric_limits<int64_t>::max());
      CHECK((pos == std::vector<uint64_t>{1, 2}));
    }
  }
  // Single row.
  {
    std::vector<std::optional<int64_t>> rows = {int64_t{42}};
    auto buf = col::encode_column(rows, 1);
    auto r = col::aggregate(buf.data(), buf.size());
    CHECK(r.rows == 1 && r.non_null == 1 && r.sum == 42);
    CHECK((col::filter_positions(buf.data(), buf.size(), col::CmpOp::Lt, 43) ==
           std::vector<uint64_t>{0}));
  }
  // Nulls excluded from sum but counted in rows (spec case).
  {
    std::vector<std::optional<int64_t>> rows = {10, std::nullopt, 20, std::nullopt, -4};
    auto buf = col::encode_column(rows, 2);  // spans multiple blocks
    auto r = col::aggregate(buf.data(), buf.size());
    CHECK(r.rows == 5 && r.non_null == 3 && r.sum == 26);
    CHECK((col::filter_positions(buf.data(), buf.size(), col::CmpOp::Gt, 0) ==
           std::vector<uint64_t>{0, 2}));
  }
  std::cout << "edge: done\n";
  return failures;
}

// Any single-byte corruption, truncation, or trailing garbage must make the
// query fail instead of publishing partial results.
int test_corrupt() {
  std::mt19937_64 rng(12345);
  auto rows = gen_rows(rng, 500);
  auto buf = col::encode_column(rows, 32);  // many blocks, both encodings

  for (size_t i = 0; i < buf.size(); ++i) {
    auto bad = buf;
    bad[i] ^= 0x5A;
    bool threw = false;
    try {
      col::aggregate(bad.data(), bad.size());
    } catch (const col::ColumnError&) {
      threw = true;
    }
    if (!threw) {
      std::cerr << "FAIL: flip at byte " << i << " went undetected\n";
      ++failures;
    }
  }
  for (size_t len = 0; len < buf.size(); ++len) {
    bool threw = false;
    try {
      col::filter_positions(buf.data(), len, col::CmpOp::Eq, 0);
    } catch (const col::ColumnError&) {
      threw = true;
    }
    if (!threw) {
      std::cerr << "FAIL: truncation to " << len << " went undetected\n";
      ++failures;
    }
  }
  {
    auto bad = buf;
    bad.push_back(0x00);
    bool threw = false;
    try {
      col::aggregate(bad.data(), bad.size());
    } catch (const col::ColumnError&) {
      threw = true;
    }
    CHECK(threw);
  }
  std::cout << "corrupt: " << buf.size() << " byte flips + truncations checked\n";
  return failures;
}

}  // namespace

int main(int argc, char** argv) {
  std::string what = argc > 1 ? argv[1] : "all";
  if (what == "random") {
    int trials = argc > 2 ? std::stoi(argv[2]) : 60;
    uint64_t seed = argc > 3 ? std::stoull(argv[3]) : 20261006;
    return test_random(trials, seed) == 0 ? 0 : 1;
  }
  if (what == "edge") return test_edge() == 0 ? 0 : 1;
  if (what == "corrupt") return test_corrupt() == 0 ? 0 : 1;
  if (what == "all") {
    int f = 0;
    f += test_edge();
    f += test_random(60, 20261006);
    f += test_corrupt();
    return f == 0 ? 0 : 1;
  }
  std::cerr << "unknown test: " << what << "\n";
  return 2;
}
