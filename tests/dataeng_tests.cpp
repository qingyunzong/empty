#include "dataeng.hpp"

#include <algorithm>
#include <cstdint>
#include <cmath>
#include <iostream>
#include <limits>
#include <random>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

using namespace dataeng;

int failures = 0;

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      std::cerr << __FILE__ << ':' << __LINE__ << ": CHECK failed: "         \
                << #condition << '\n';                                       \
      ++failures;                                                            \
    }                                                                        \
  } while (false)

template <typename T>
bool equals(const std::vector<T>& actual, const std::vector<T>& expected) {
  return actual == expected;
}

std::vector<std::uint32_t> pages(std::initializer_list<std::uint32_t> values) {
  return std::vector<std::uint32_t>(values);
}

std::vector<RowRange> ranges(std::initializer_list<RowRange> values) {
  return std::vector<RowRange>(values);
}

ColumnIndex make_int64_index(
    const std::vector<std::pair<std::int64_t, std::int64_t>>& bounds,
    const std::vector<bool>& null_pages = {},
    const std::vector<std::int64_t>& null_counts = {}) {
  ColumnIndex index;
  index.null_pages = null_pages;
  if (index.null_pages.empty()) {
    index.null_pages.assign(bounds.size(), false);
  }
  for (const auto& [min_value, max_value] : bounds) {
    index.min_values.push_back(Literal::Int64(min_value).bytes);
    index.max_values.push_back(Literal::Int64(max_value).bytes);
  }
  index.null_counts = null_counts;
  return index;
}

OffsetIndex make_offsets(const std::vector<std::int64_t>& first_rows,
                         std::int64_t row_count) {
  OffsetIndex index;
  index.num_rows = row_count;
  for (const std::int64_t first_row : first_rows) {
    index.page_locations.push_back(
        PageLocation{0, 100, first_row});
  }
  return index;
}

void test_integer_bounds_and_row_ranges() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Int64);
  const ColumnIndex index =
      make_int64_index({{0, 9}, {10, 19}, {20, 29}, {30, 39}},
                       {false, false, false, false}, {0, 0, 0, 0});
  const OffsetIndex offsets = make_offsets({0, 10, 20, 30}, 40);

  {
    const Expr expr = Expr::compare(CompareOp::GreaterEqual, Literal::Int64(25));
    const PageSelection selection =
        select_pages(descriptor, index, offsets, expr);
    CHECK(equals(selection.candidate_pages, pages({2, 3})));
    CHECK(equals(selection.pruned_pages, pages({0, 1})));
    CHECK(equals(selection.row_ranges, ranges({{20, 40}})));
    CHECK(selection.row_ranges_complete);
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index, offsets,
        Expr::compare(CompareOp::Equal, Literal::Int64(5)));
    CHECK(equals(selection.candidate_pages, pages({0})));
    CHECK(equals(selection.row_ranges, ranges({{0, 10}})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index, offsets,
        Expr::compare(CompareOp::Less, Literal::Int64(10)));
    CHECK(equals(selection.candidate_pages, pages({0})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index, offsets,
        Expr::compare(CompareOp::LessEqual, Literal::Int64(9)));
    CHECK(equals(selection.candidate_pages, pages({0})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index, offsets,
        Expr::compare(CompareOp::Greater, Literal::Int64(29)));
    CHECK(equals(selection.candidate_pages, pages({3})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index, offsets,
        Expr::compare(CompareOp::NotEqual, Literal::Int64(5)));
    CHECK(equals(selection.candidate_pages, pages({0, 1, 2, 3})));
  }

  ColumnIndex singleton = index;
  singleton.min_values[0] = Literal::Int64(5).bytes;
  singleton.max_values[0] = Literal::Int64(5).bytes;
  {
    const PageSelection selection = select_pages(
        descriptor, singleton, offsets,
        Expr::compare(CompareOp::NotEqual, Literal::Int64(5)));
    CHECK(equals(selection.candidate_pages, pages({1, 2, 3})));
  }
}

void test_null_pages() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Int64);
  ColumnIndex index;
  index.null_pages = {true, false, false};
  index.min_values = {Literal::Int64(0).bytes, Literal::Int64(0).bytes,
                      Literal::Int64(2).bytes};
  index.max_values = {Literal::Int64(0).bytes, Literal::Int64(1).bytes,
                      Literal::Int64(3).bytes};
  index.null_counts = {1, 0, -1};

  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Equal, Literal::Int64(1)));
    CHECK(equals(selection.candidate_pages, pages({1})));
  }
  {
    const PageSelection selection =
        select_pages(descriptor, index, Expr::is_null());
    CHECK(equals(selection.candidate_pages, pages({0, 2})));
  }
  {
    const PageSelection selection =
        select_pages(descriptor, index, Expr::is_not_null());
    CHECK(equals(selection.candidate_pages, pages({1, 2})));
  }
  {
    const Expr expr = Expr::any(
        {Expr::compare(CompareOp::Equal, Literal::Int64(1)), Expr::is_null()});
    const PageSelection selection = select_pages(descriptor, index, expr);
    CHECK(equals(selection.candidate_pages, pages({0, 1, 2})));
  }
}

void test_nan() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Float);
  ColumnIndex index;
  index.null_pages = {false, false, false, true};

  const float nan = std::numeric_limits<float>::quiet_NaN();
  index.min_values = {Literal::Float(nan).bytes, Literal::Float(1.0F).bytes,
                      Literal::Float(5.0F).bytes, std::string()};
  index.max_values = {Literal::Float(nan).bytes, Literal::Float(2.0F).bytes,
                      Literal::Float(5.0F).bytes, std::string()};
  index.null_counts = {0, 0, 0, 1};
  index.may_contain_nan = {true, true, false, false};

  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Equal, Literal::Float(1.0F)));
    // Page 0 has NaN statistics and page 1 can contain NaN, but only page 0
    // is allowed to remain because its bounds are unusable.
    CHECK(equals(selection.candidate_pages, pages({0, 1})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::NotEqual, Literal::Float(5.0F)));
    CHECK(equals(selection.candidate_pages, pages({0, 1})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Equal,
                      Literal::Float(std::numeric_limits<float>::quiet_NaN())));
    CHECK(equals(selection.candidate_pages, pages({})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::NotEqual,
                      Literal::Float(std::numeric_limits<float>::quiet_NaN())));
    CHECK(equals(selection.candidate_pages, pages({0, 1, 2})));
  }
  {
    const PageSelection selection = select_pages(descriptor, index,
                                                 Expr::is_nan());
    CHECK(equals(selection.candidate_pages, pages({0, 1})));
  }
  {
    const PageSelection selection = select_pages(descriptor, index,
                                                 Expr::is_not_nan());
    CHECK(equals(selection.candidate_pages, pages({0, 1, 2})));
  }
  {
    // NOT(x < 5) is true for a NaN row, so the page must stay a candidate.
    const Expr expr =
        Expr::negate(Expr::compare(CompareOp::Less, Literal::Float(5.0F)));
    const PageSelection selection = select_pages(descriptor, index, expr);
    CHECK(equals(selection.candidate_pages, pages({0, 1, 2})));
  }
  {
    // Literal NaN: x < NaN is false for every value, so NOT(...) is true.
    const Expr expr = Expr::negate(Expr::compare(
        CompareOp::Less,
        Literal::Float(std::numeric_limits<float>::quiet_NaN())));
    const PageSelection selection = select_pages(descriptor, index, expr);
    CHECK(equals(selection.candidate_pages, pages({0, 1, 2})));
  }
  {
    // x != NaN is true for every non-null value, so NOT(x != NaN) is false.
    const Expr expr = Expr::negate(Expr::compare(
        CompareOp::NotEqual,
        Literal::Float(std::numeric_limits<float>::quiet_NaN())));
    const PageSelection selection = select_pages(descriptor, index, expr);
    CHECK(equals(selection.candidate_pages, pages({})));
  }

  // With an explicit no-NaN hint, NOT(x < 5) can be pruned when max < 5.
  ColumnIndex no_nan = index;
  no_nan.may_contain_nan = {false, false, false, false};
  {
    const Expr expr =
        Expr::negate(Expr::compare(CompareOp::Less, Literal::Float(5.0F)));
    const PageSelection selection = select_pages(descriptor, no_nan, expr);
    CHECK(equals(selection.candidate_pages, pages({0, 2})));
  }
}

void test_infinity() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Float);
  ColumnIndex index;
  index.null_pages = {false, false};
  index.min_values = {Literal::Float(1.0F).bytes,
                      Literal::Float(1.0F).bytes};
  index.max_values = {
      Literal::Float(std::numeric_limits<float>::infinity()).bytes,
      Literal::Float(2.0F).bytes,
  };
  index.null_counts = {0, 0};

  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(
            CompareOp::Equal,
            Literal::Float(std::numeric_limits<float>::infinity())));
    CHECK(equals(selection.candidate_pages, pages({0})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(
            CompareOp::Greater,
            Literal::Float(std::numeric_limits<float>::infinity())));
    CHECK(equals(selection.candidate_pages, pages({})));
  }
}

void test_strings_and_truncation() {
  ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::ByteArray, LogicalType::Utf8);
  ColumnIndex index;
  index.null_pages = {false, false, false, false};

  index.min_values = {Literal::String("apple").bytes,
                      Literal::String("cat").bytes,
                      Literal::String("abc").bytes,
                      Literal::String("b").bytes};
  index.max_values = {Literal::String("banana").bytes,
                      Literal::String("cat").bytes,
                      Literal::String("abc").bytes,
                      Literal::String("bz").bytes};
  index.is_min_value_exact = {true, true, false, false};
  index.is_max_value_exact = {true, true, false, true};
  index.null_counts = {0, 0, 0, 0};

  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Equal, Literal::String("avocado")));
    CHECK(equals(selection.candidate_pages, pages({0})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Equal, Literal::String("zebra")));
    CHECK(equals(selection.candidate_pages, pages({})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Less, Literal::String("apple")));
    CHECK(equals(selection.candidate_pages, pages({2})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::LessEqual, Literal::String("apple")));
    CHECK(equals(selection.candidate_pages, pages({0, 2})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Greater, Literal::String("banana")));
    CHECK(equals(selection.candidate_pages, pages({1, 3})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::NotEqual, Literal::String("cat")));
    CHECK(equals(selection.candidate_pages, pages({0, 2, 3})));
  }
  {
    // "abc" is a truncated max, so values with that prefix may be "abcz".
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Equal, Literal::String("abcz")));
    CHECK(equals(selection.candidate_pages, pages({2})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Equal, Literal::String("abd")));
    // successor("abc") == "abd", so no value starting with "abc" can be "abd".
    CHECK(equals(selection.candidate_pages, pages({})));
  }
  {
    const PageSelection selection = select_pages(
        descriptor, index,
        Expr::compare(CompareOp::Less, Literal::String("a")));
    // Page 3's truncated min "b" is still a valid lower bound.
    CHECK(equals(selection.candidate_pages, pages({})));
  }

  ColumnDescriptor unknown;
  unknown.physical_type = PhysicalType::ByteArray;
  unknown.sort_order = SortOrder::Unknown;
  ColumnIndex unknown_index;
  unknown_index.null_pages = {false};
  unknown_index.min_values = {Literal::String("a").bytes};
  unknown_index.max_values = {Literal::String("z").bytes};
  const PageSelection selection = select_pages(
      unknown, unknown_index,
      Expr::compare(CompareOp::Equal, Literal::String("m")));
  CHECK(equals(selection.candidate_pages, pages({0})));
}

void test_boolean_and_unknown_order() {
  const ColumnDescriptor boolean =
      ColumnDescriptor::make(PhysicalType::Boolean);
  ColumnIndex index;
  index.null_pages = {false, false};
  index.min_values = {Literal::Boolean(false).bytes,
                      Literal::Boolean(true).bytes};
  index.max_values = {Literal::Boolean(false).bytes,
                      Literal::Boolean(true).bytes};
  index.null_counts = {0, 0};

  {
    const PageSelection selection = select_pages(
        boolean, index,
        Expr::compare(CompareOp::Equal, Literal::Boolean(true)));
    CHECK(equals(selection.candidate_pages, pages({1})));
  }
  {
    ColumnDescriptor unknown = ColumnDescriptor::make(PhysicalType::Int32);
    unknown.sort_order = SortOrder::Unknown;
    ColumnIndex ints;
    ints.null_pages = {false};
    ints.min_values = {Literal::Int32(0).bytes};
    ints.max_values = {Literal::Int32(10).bytes};
    const PageSelection selection = select_pages(
        unknown, ints,
        Expr::compare(CompareOp::Equal, Literal::Int32(100)));
    CHECK(equals(selection.candidate_pages, pages({0})));

    // With no ordering we keep all pages, but the scan oracle can still
    // evaluate physical equality for a cross-check.
    std::vector<ScannedPage> scanned(1);
    scanned[0].page_index = 0;
    scanned[0].rows = {
        {ScannedValue::FromLiteral(Literal::Int32(5))},
        {ScannedValue::FromLiteral(Literal::Int32(7))},
    };
    const VerificationReport report = verify_page_selection(
        selection.candidate_pages, scanned, unknown,
        Expr::compare(CompareOp::Equal, Literal::Int32(5)));
    CHECK(report.ok);
    CHECK(report.matching_rows == 1);
  }
}

std::string big_endian_bytes(std::uint32_t value) {
  std::string bytes(4, '\0');
  bytes[0] = static_cast<char>((value >> 24) & 0xFFu);
  bytes[1] = static_cast<char>((value >> 16) & 0xFFu);
  bytes[2] = static_cast<char>((value >> 8) & 0xFFu);
  bytes[3] = static_cast<char>(value & 0xFFu);
  return bytes;
}

void test_decimal_and_unsigned_semantics() {
  ColumnDescriptor decimal = ColumnDescriptor::make(
      PhysicalType::FixedLenByteArray, LogicalType::Decimal);
  decimal.type_length = 4;
  ColumnIndex index;
  index.null_pages = {false};
  index.min_values = {big_endian_bytes(0xFFFFFFFEu)};  // -2
  index.max_values = {big_endian_bytes(0x00000001u)};  // +1
  index.is_min_value_exact = {true};
  index.is_max_value_exact = {true};
  index.null_counts = {0};

  {
    const PageSelection selection = select_pages(
        decimal, index,
        Expr::compare(CompareOp::Equal,
                      Literal::Binary(big_endian_bytes(0))));
    CHECK(equals(selection.candidate_pages, pages({0})));
  }
  {
    const PageSelection selection = select_pages(
        decimal, index,
        Expr::compare(CompareOp::Equal,
                      Literal::Binary(big_endian_bytes(0xFFFFFFFDu))));
    CHECK(equals(selection.candidate_pages, pages({})));
  }
  {
    const PageSelection selection = select_pages(
        decimal, index,
        Expr::compare(CompareOp::Greater,
                      Literal::Binary(big_endian_bytes(1))));
    CHECK(equals(selection.candidate_pages, pages({})));
  }
  {
    const PageSelection selection = select_pages(
        decimal, index,
        Expr::compare(CompareOp::Less,
                      Literal::Binary(big_endian_bytes(0xFFFFFFFEu))));
    CHECK(equals(selection.candidate_pages, pages({})));
  }

  ColumnDescriptor unsigned_int =
      ColumnDescriptor::make(PhysicalType::Int32, LogicalType::Integer);
  unsigned_int.sort_order = SortOrder::Unsigned;
  ColumnIndex uint_index;
  uint_index.null_pages = {false};
  uint_index.min_values = {Literal::UInt32(0).bytes};
  uint_index.max_values = {Literal::UInt32(10).bytes};
  uint_index.null_counts = {0};

  {
    const PageSelection selection = select_pages(
        unsigned_int, uint_index,
        Expr::compare(CompareOp::Equal, Literal::UInt32(20)));
    CHECK(equals(selection.candidate_pages, pages({})));
  }
  {
    // A signed negative literal is ambiguous for an unsigned column.  The
    // pruner must not interpret it as a bit pattern and prune incorrectly.
    const PageSelection selection = select_pages(
        unsigned_int, uint_index,
        Expr::compare(CompareOp::Equal, Literal::Int32(-1)));
    CHECK(equals(selection.candidate_pages, pages({0})));
  }
}

void test_expressions() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Int64);
  const ColumnIndex index =
      make_int64_index({{0, 9}, {10, 19}, {20, 29}, {30, 39}},
                       {false, false, false, false}, {0, 0, 0, 0});
  const OffsetIndex offsets = make_offsets({0, 10, 20, 30}, 40);

  {
    const Expr expr = Expr::all(
        {Expr::compare(CompareOp::GreaterEqual, Literal::Int64(10)),
         Expr::compare(CompareOp::LessEqual, Literal::Int64(19))});
    const PageSelection selection =
        select_pages(descriptor, index, offsets, expr);
    CHECK(equals(selection.candidate_pages, pages({1})));
  }
  {
    const Expr expr = Expr::any(
        {Expr::compare(CompareOp::Less, Literal::Int64(10)),
         Expr::compare(CompareOp::Greater, Literal::Int64(29))});
    const PageSelection selection =
        select_pages(descriptor, index, offsets, expr);
    CHECK(equals(selection.candidate_pages, pages({0, 3})));
  }
  {
    const Expr expr =
        Expr::negate(Expr::compare(CompareOp::Equal, Literal::Int64(5)));
    const PageSelection selection =
        select_pages(descriptor, index, offsets, expr);
    CHECK(equals(selection.candidate_pages, pages({0, 1, 2, 3})));
  }
  {
    const Expr expr = Expr::negate(Expr::all(
        {Expr::compare(CompareOp::GreaterEqual, Literal::Int64(10)),
         Expr::compare(CompareOp::LessEqual, Literal::Int64(19))}));
    const PageSelection selection =
        select_pages(descriptor, index, offsets, expr);
    CHECK(equals(selection.candidate_pages, pages({0, 2, 3})));
  }
}

void test_repeated_row_ranges() {
  OffsetIndex offsets;
  offsets.num_rows = 3;
  offsets.page_locations = {
      {0, 10, 0}, {10, 10, 0}, {20, 10, 1},
      {30, 10, 1}, {40, 10, 2},
  };

  {
    const auto merged =
        merge_row_ranges(page_row_ranges(offsets, pages({1, 3}), 3));
    CHECK(equals(merged, ranges({{0, 2}})));
  }
  {
    const auto merged =
        merge_row_ranges(page_row_ranges(offsets, pages({0}), 3));
    CHECK(equals(merged, ranges({{0, 1}})));
  }
  {
    const auto merged =
        merge_row_ranges(page_row_ranges(offsets, pages({0, 2, 4}), 3));
    CHECK(equals(merged, ranges({{0, 3}})));
  }
  {
    const auto merged =
        merge_row_ranges(page_row_ranges(offsets, pages({0, 2}), 3));
    CHECK(equals(merged, ranges({{0, 2}})));
  }

  OffsetIndex sparse;
  sparse.num_rows = 40;
  sparse.page_locations = {{0, 10, 0}, {10, 10, 10},
                           {20, 10, 20}, {30, 10, 30}};
  const auto separated =
      merge_row_ranges(page_row_ranges(sparse, pages({0, 2}), 40));
  CHECK(equals(separated, ranges({{0, 10}, {20, 30}})));

  // End-to-end selection over a repeated column.
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Int64);
  const ColumnIndex index =
      make_int64_index({{0, 0}, {10, 10}, {20, 20}, {10, 10}, {30, 30}},
                       {false, false, false, false, false},
                       {0, 0, 0, 0, 0});
  const PageSelection selection = select_pages(
      descriptor, index, offsets,
      Expr::compare(CompareOp::Equal, Literal::Int64(10)));
  CHECK(equals(selection.candidate_pages, pages({1, 3})));
  CHECK(equals(selection.row_ranges, ranges({{0, 2}})));
  CHECK(selection.row_ranges_complete);
}

void test_unmapped_candidates() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Int64);
  ColumnIndex index;
  index.null_pages = {false, false};
  index.min_values = {Literal::Int64(0).bytes, Literal::Int64(100).bytes};
  index.max_values = {Literal::Int64(0).bytes, Literal::Int64(100).bytes};
  index.null_counts = {0, 0};

  OffsetIndex offsets;
  offsets.num_rows = 10;
  offsets.page_locations = {{0, 100, 0}};  // page 1 has no location

  const PageSelection selection = select_pages(
      descriptor, index, offsets,
      Expr::compare(CompareOp::Equal, Literal::Int64(100)));
  CHECK(equals(selection.candidate_pages, pages({1})));
  CHECK(!selection.row_ranges_complete);
  CHECK(equals(selection.row_ranges, ranges({{0, 10}})));

  OffsetIndex no_locations;
  no_locations.num_rows = 10;
  ColumnIndex one_page;
  one_page.null_pages = {false};
  one_page.min_values = {Literal::Int64(0).bytes};
  one_page.max_values = {Literal::Int64(0).bytes};
  const PageSelection conservative = select_pages(
      descriptor, one_page, no_locations,
      Expr::compare(CompareOp::Equal, Literal::Int64(0)));
  CHECK(equals(conservative.candidate_pages, pages({0})));
  CHECK(!conservative.row_ranges_complete);
  CHECK(equals(conservative.row_ranges, ranges({{0, 10}})));
}

ScannedValue value(std::int64_t number) {
  return ScannedValue::FromLiteral(Literal::Int64(number));
}

ScannedValue string_value(std::string_view text) {
  return ScannedValue::FromLiteral(Literal::String(text));
}

void test_scan_verification() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Int64);
  const ColumnIndex index =
      make_int64_index({{0, 9}, {10, 19}}, {false, false}, {0, 0});
  const OffsetIndex offsets = make_offsets({0, 10}, 20);

  std::vector<ScannedPage> scanned(2);
  scanned[0].page_index = 0;
  scanned[0].first_row_index = 0;
  scanned[1].page_index = 1;
  scanned[1].first_row_index = 10;
  for (std::int64_t i = 0; i < 10; ++i) {
    scanned[0].rows.push_back({value(i)});
    scanned[1].rows.push_back({value(i + 10)});
  }

  const Expr expr =
      Expr::compare(CompareOp::GreaterEqual, Literal::Int64(15));
  const PageSelection selection =
      select_pages(descriptor, index, offsets, expr);
  const VerificationReport report =
      verify_selection(selection, scanned, descriptor, expr);
  CHECK(report.ok);
  CHECK(report.matching_rows == 5);
  CHECK(report.missed_rows.empty());
  CHECK(report.matching_pages_not_selected.empty());

  const VerificationReport page_report = verify_page_selection(
      selection.candidate_pages, scanned, descriptor, expr);
  CHECK(page_report.ok);
  CHECK(page_report.matching_rows == 5);

  PageSelection wrong;
  wrong.candidate_pages = pages({0});
  wrong.row_ranges = ranges({{0, 10}});
  const VerificationReport wrong_report =
      verify_selection(wrong, scanned, descriptor, expr);
  CHECK(!wrong_report.ok);
  CHECK(!wrong_report.missed_rows.empty());
  CHECK(equals(wrong_report.matching_pages_not_selected, pages({1})));

  // Truncated string stats must not hide "abcz".
  ColumnDescriptor strings =
      ColumnDescriptor::make(PhysicalType::ByteArray, LogicalType::Utf8);
  ColumnIndex string_index;
  string_index.null_pages = {false};
  string_index.min_values = {Literal::String("abc").bytes};
  string_index.max_values = {Literal::String("abc").bytes};
  string_index.is_min_value_exact = {false};
  string_index.is_max_value_exact = {false};
  string_index.null_counts = {0};

  const Expr string_expr =
      Expr::compare(CompareOp::Equal, Literal::String("abcz"));
  OffsetIndex string_offsets;
  string_offsets.num_rows = 1;
  string_offsets.page_locations = {{0, 100, 0}};
  const PageSelection string_selection =
      select_pages(strings, string_index, string_offsets, string_expr);
  CHECK(equals(string_selection.candidate_pages, pages({0})));

  std::vector<ScannedPage> string_pages(1);
  string_pages[0].page_index = 0;
  string_pages[0].rows = {{string_value("abcz")}};
  const VerificationReport string_report =
      verify_selection(string_selection, string_pages, strings, string_expr);
  CHECK(string_report.ok);
  CHECK(string_report.matching_rows == 1);
}

void test_fuzz_integer() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Int64);
  std::mt19937_64 random(42);
  std::uniform_int_distribution<int> value_dist(-100, 100);
  std::uniform_int_distribution<int> literal_dist(-110, 110);
  std::bernoulli_distribution null_dist(0.2);

  constexpr std::size_t kPages = 24;
  constexpr std::size_t kRowsPerPage = 6;
  constexpr std::size_t kRows = kPages * kRowsPerPage;

  ColumnIndex index;
  OffsetIndex offsets;
  offsets.num_rows = static_cast<std::int64_t>(kRows);
  std::vector<ScannedPage> scanned(kPages);

  for (std::size_t page = 0; page < kPages; ++page) {
    std::vector<std::int64_t> values;
    std::int64_t null_count = 0;
    scanned[page].page_index = static_cast<std::uint32_t>(page);
    scanned[page].first_row_index =
        static_cast<std::int64_t>(page * kRowsPerPage);
    offsets.page_locations.push_back(
        PageLocation{0, 100, scanned[page].first_row_index});

    for (std::size_t row = 0; row < kRowsPerPage; ++row) {
      if (null_dist(random)) {
        ++null_count;
        scanned[page].rows.push_back({ScannedValue::Null()});
      } else {
        const std::int64_t number = value_dist(random);
        values.push_back(number);
        scanned[page].rows.push_back({value(number)});
      }
    }

    if (values.empty()) {
      index.null_pages.push_back(true);
      index.min_values.push_back(std::string());
      index.max_values.push_back(std::string());
    } else {
      const auto [min_it, max_it] =
          std::minmax_element(values.begin(), values.end());
      index.null_pages.push_back(false);
      index.min_values.push_back(Literal::Int64(*min_it).bytes);
      index.max_values.push_back(Literal::Int64(*max_it).bytes);
    }
    index.null_counts.push_back(null_count);
    index.num_values.push_back(static_cast<std::int64_t>(kRowsPerPage));
  }

  const CompareOp ops[] = {CompareOp::Equal, CompareOp::NotEqual,
                           CompareOp::Less, CompareOp::LessEqual,
                           CompareOp::Greater, CompareOp::GreaterEqual};

  for (const CompareOp op : ops) {
    for (int trial = 0; trial < 40; ++trial) {
      const Expr expr =
          Expr::compare(op, Literal::Int64(literal_dist(random)));
      const PageSelection selection =
          select_pages(descriptor, index, offsets, expr);
      const VerificationReport report =
          verify_selection(selection, scanned, descriptor, expr);
      CHECK(report.ok);
    }
  }
}

void test_fuzz_truncated_strings() {
  ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::ByteArray, LogicalType::Utf8);
  std::mt19937 random(7);
  std::uniform_int_distribution<int> length_dist(1, 5);
  std::uniform_int_distribution<int> char_dist(0, 2);
  constexpr std::string_view alphabet = "abc";

  constexpr std::size_t kPages = 16;
  constexpr std::size_t kRowsPerPage = 5;
  constexpr std::size_t kRows = kPages * kRowsPerPage;

  ColumnIndex index;
  OffsetIndex offsets;
  offsets.num_rows = static_cast<std::int64_t>(kRows);
  std::vector<ScannedPage> scanned(kPages);

  for (std::size_t page = 0; page < kPages; ++page) {
    std::vector<std::string> values;
    scanned[page].page_index = static_cast<std::uint32_t>(page);
    scanned[page].first_row_index =
        static_cast<std::int64_t>(page * kRowsPerPage);
    offsets.page_locations.push_back(
        PageLocation{0, 100, scanned[page].first_row_index});

    for (std::size_t row = 0; row < kRowsPerPage; ++row) {
      std::string text;
      const int length = length_dist(random);
      for (int i = 0; i < length; ++i) {
        text.push_back(
            alphabet[static_cast<std::size_t>(char_dist(random))]);
      }
      values.push_back(text);
      scanned[page].rows.push_back({string_value(text)});
    }

    const auto [min_it, max_it] =
        std::minmax_element(values.begin(), values.end());
    const std::string min_stat = min_it->substr(0, 2);
    const std::string max_stat = max_it->substr(0, 2);
    index.null_pages.push_back(false);
    index.min_values.push_back(min_stat);
    index.max_values.push_back(max_stat);
    index.is_min_value_exact.push_back(*min_it == min_stat);
    index.is_max_value_exact.push_back(*max_it == max_stat);
    index.null_counts.push_back(0);
    index.num_values.push_back(static_cast<std::int64_t>(kRowsPerPage));
  }

  std::uniform_int_distribution<int> length_dist2(1, 5);
  std::uniform_int_distribution<int> char_dist2(0, 3);
  constexpr std::string_view alphabet2 = "abcd";

  for (int trial = 0; trial < 120; ++trial) {
    std::string literal;
    const int length = length_dist2(random);
    for (int i = 0; i < length; ++i) {
      literal.push_back(
          alphabet2[static_cast<std::size_t>(char_dist2(random))]);
    }
    const Expr expr =
        Expr::compare(CompareOp::Equal, Literal::String(literal));
    const PageSelection selection =
        select_pages(descriptor, index, offsets, expr);
    const VerificationReport report =
        verify_selection(selection, scanned, descriptor, expr);
    CHECK(report.ok);
  }
}

void test_float_scan_nan() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Double);
  ColumnIndex index;
  index.null_pages = {false};
  index.min_values = {Literal::Double(1.0).bytes};
  index.max_values = {Literal::Double(1.0).bytes};
  index.null_counts = {0};

  std::vector<ScannedPage> scanned(1);
  scanned[0].page_index = 0;
  scanned[0].rows = {
      {ScannedValue::FromLiteral(Literal::Double(1.0))},
      {ScannedValue::FromLiteral(
          Literal::Double(std::numeric_limits<double>::quiet_NaN()))},
  };

  const Expr expr =
      Expr::compare(CompareOp::NotEqual, Literal::Double(1.0));
  OffsetIndex offsets;
  offsets.num_rows = 2;
  offsets.page_locations = {{0, 100, 0}};
  const PageSelection selection =
      select_pages(descriptor, index, offsets, expr);
  CHECK(equals(selection.candidate_pages, pages({0})));
  const VerificationReport report =
      verify_selection(selection, scanned, descriptor, expr);
  CHECK(report.ok);
  CHECK(report.matching_rows == 1);

  const Expr not_less =
      Expr::negate(Expr::compare(CompareOp::Less, Literal::Double(5.0)));
  const PageSelection not_less_selection =
      select_pages(descriptor, index, offsets, not_less);
  CHECK(equals(not_less_selection.candidate_pages, pages({0})));
  const VerificationReport not_less_report =
      verify_selection(not_less_selection, scanned, descriptor, not_less);
  CHECK(not_less_report.ok);
  CHECK(not_less_report.matching_rows == 1);
}

void test_fuzz_float_nan() {
  const ColumnDescriptor descriptor =
      ColumnDescriptor::make(PhysicalType::Float);
  std::mt19937 random(99);
  std::uniform_int_distribution<int> value_dist(0, 4);  // -1, 0, 1, NaN, null

  constexpr std::size_t kPages = 10;
  constexpr std::size_t kRowsPerPage = 5;
  constexpr std::size_t kRows = kPages * kRowsPerPage;

  ColumnIndex index;
  OffsetIndex offsets;
  offsets.num_rows = static_cast<std::int64_t>(kRows);
  std::vector<ScannedPage> scanned(kPages);

  const float nan = std::numeric_limits<float>::quiet_NaN();

  for (std::size_t page = 0; page < kPages; ++page) {
    std::vector<float> finite_values;
    bool has_nan = false;
    bool has_non_null = false;
    std::int64_t null_count = 0;

    scanned[page].page_index = static_cast<std::uint32_t>(page);
    scanned[page].first_row_index =
        static_cast<std::int64_t>(page * kRowsPerPage);
    offsets.page_locations.push_back(
        PageLocation{0, 100, scanned[page].first_row_index});

    for (std::size_t row = 0; row < kRowsPerPage; ++row) {
      const int kind = value_dist(random);
      if (kind == 4) {
        ++null_count;
        scanned[page].rows.push_back({ScannedValue::Null()});
        continue;
      }
      has_non_null = true;
      float number = 0.0F;
      if (kind == 0) {
        number = -1.0F;
      } else if (kind == 1) {
        number = 0.0F;
      } else if (kind == 2) {
        number = 1.0F;
      } else {
        number = nan;
        has_nan = true;
      }
      if (!std::isnan(number)) {
        finite_values.push_back(number);
      }
      scanned[page].rows.push_back(
          {ScannedValue::FromLiteral(Literal::Float(number))});
    }

    if (!has_non_null) {
      index.null_pages.push_back(true);
      index.min_values.push_back(std::string());
      index.max_values.push_back(std::string());
    } else if (finite_values.empty()) {
      index.null_pages.push_back(false);
      index.min_values.push_back(Literal::Float(nan).bytes);
      index.max_values.push_back(Literal::Float(nan).bytes);
    } else {
      const auto [min_it, max_it] =
          std::minmax_element(finite_values.begin(), finite_values.end());
      index.null_pages.push_back(false);
      index.min_values.push_back(Literal::Float(*min_it).bytes);
      index.max_values.push_back(Literal::Float(*max_it).bytes);
    }
    index.null_counts.push_back(null_count);
    index.num_values.push_back(static_cast<std::int64_t>(kRowsPerPage));
    index.is_min_value_exact.push_back(true);
    index.is_max_value_exact.push_back(true);
    index.may_contain_nan.push_back(has_nan);
  }

  const CompareOp ops[] = {CompareOp::Equal, CompareOp::NotEqual,
                           CompareOp::Less, CompareOp::LessEqual,
                           CompareOp::Greater, CompareOp::GreaterEqual};
  const float literals[] = {-2.0F, -1.0F, 0.0F, 1.0F, 2.0F, nan};

  const auto check = [&](const Expr& expr) {
    const PageSelection selection =
        select_pages(descriptor, index, offsets, expr);
    const VerificationReport report =
        verify_selection(selection, scanned, descriptor, expr);
    CHECK(report.ok);
  };

  for (const CompareOp op : ops) {
    for (const float literal : literals) {
      const Expr expr =
          Expr::compare(op, Literal::Float(literal));
      check(expr);
      check(Expr::negate(expr));
    }
  }
  check(Expr::is_nan());
  check(Expr::is_not_nan());
  check(Expr::is_null());
  check(Expr::is_not_null());
}

}  // namespace

int main() {
  test_integer_bounds_and_row_ranges();
  test_null_pages();
  test_nan();
  test_infinity();
  test_strings_and_truncation();
  test_boolean_and_unknown_order();
  test_decimal_and_unsigned_semantics();
  test_expressions();
  test_repeated_row_ranges();
  test_unmapped_candidates();
  test_scan_verification();
  test_fuzz_integer();
  test_fuzz_truncated_strings();
  test_float_scan_nan();
  test_fuzz_float_nan();

  if (failures != 0) {
    std::cerr << failures << " test check(s) failed\n";
    return 1;
  }
  std::cout << "all dataeng tests passed\n";
  return 0;
}
