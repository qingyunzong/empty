#include "dataeng.hpp"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <iostream>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <vector>

namespace {

int g_failures = 0;

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: "         \
                << #condition << "\n";                                       \
      ++g_failures;                                                          \
    }                                                                        \
  } while (false)

#define CHECK_EQ(lhs, rhs)                                                   \
  do {                                                                       \
    const auto& check_lhs = (lhs);                                           \
    const auto& check_rhs = (rhs);                                           \
    if (!(check_lhs == check_rhs)) {                                         \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK_EQ failed: "      \
                << #lhs << " == " << #rhs << "\n";                           \
      ++g_failures;                                                          \
    }                                                                        \
  } while (false)

using dataeng::BoundaryOrder;
using dataeng::ColumnPageIndex;
using dataeng::CompareOp;
using dataeng::PageLocation;
using dataeng::PageStatistics;
using dataeng::Predicate;
using dataeng::PruneResult;
using dataeng::PruneStatus;
using dataeng::RowGroupIndex;
using dataeng::RowRange;
using dataeng::Value;

Value i64(std::int64_t value) { return Value::int64(value); }

PageStatistics stats(std::optional<Value> min, std::optional<Value> max,
                     std::optional<std::int64_t> null_count = 0,
                     bool null_page = false) {
  PageStatistics page;
  page.min_value = std::move(min);
  page.max_value = std::move(max);
  page.null_count = null_count;
  page.null_page = null_page;
  return page;
}

ColumnPageIndex column(std::vector<PageStatistics> pages,
                       std::vector<std::int64_t> first_rows,
                       BoundaryOrder order = BoundaryOrder::Unordered,
                       std::int32_t max_rep = 0,
                       std::int32_t max_def = 0) {
  ColumnPageIndex result;
  result.pages = std::move(pages);
  result.boundary_order = order;
  result.max_repetition_level = max_rep;
  result.max_definition_level = max_def;
  for (std::int64_t row : first_rows) {
    PageLocation location;
    location.first_row_index = row;
    result.page_locations.push_back(location);
  }
  return result;
}

RowGroupIndex rowGroup(std::int64_t rows,
                       std::vector<std::pair<std::string, ColumnPageIndex>> cols) {
  RowGroupIndex group;
  group.num_rows = rows;
  for (auto& [name, col] : cols) {
    group.columns.emplace(name, std::move(col));
  }
  return group;
}

std::vector<std::int64_t> matchingRows(const PruneResult& result,
                                       std::int64_t num_rows) {
  std::vector<std::int64_t> rows;
  for (std::int64_t row = 0; row < num_rows; ++row) {
    if (result.containsRow(row)) {
      rows.push_back(row);
    }
  }
  return rows;
}

void testBasicFlatPruning() {
  RowGroupIndex group = rowGroup(
      100, {{"a", column({stats(i64(0), i64(24)), stats(i64(25), i64(49)),
                          stats(i64(50), i64(74)), stats(i64(75), i64(99))},
                         {0, 25, 50, 75})}});

  {
    const PruneResult result = dataeng::prune(group, Predicate::ge("a", i64(60)));
    CHECK_EQ(result.status, PruneStatus::Ok);
    CHECK(matchingRows(result, 100) ==
          (std::vector<std::int64_t>{50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
                                     60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
                                     70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
                                     80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
                                     90, 91, 92, 93, 94, 95, 96, 97, 98, 99}));
    CHECK(!result.isPageCandidate("a", 0));
    CHECK(!result.isPageCandidate("a", 1));
    CHECK(result.isPageCandidate("a", 2));
    CHECK(result.isPageCandidate("a", 3));
  }

  {
    const PruneResult result = dataeng::prune(group, Predicate::lt("a", i64(10)));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(result.candidate_rows.front().begin, 0);
    CHECK_EQ(result.candidate_rows.front().end, 25);
  }

  {
    const PruneResult result = dataeng::prune(group, Predicate::eq("a", i64(100)));
    CHECK(result.candidate_rows.empty());
    CHECK_EQ(result.candidateRowCount(), 0);
    for (std::int32_t page = 0; page < 4; ++page) {
      CHECK(!result.isPageCandidate("a", page));
      if (result.pageSelection("a") != nullptr) {
        CHECK(!result.pageSelection("a")->all);
      }
    }
  }
}

void testExactEqualityAndTruncation() {
  RowGroupIndex group =
      rowGroup(20, {{"n", column({stats(i64(5), i64(5)), stats(i64(5), i64(9))},
                                 {0, 10})},
                    {"s", column({stats(Value::string("abc"), Value::string("abd"))},
                                 {0})}});
  group.columns["s"].pages[0].null_count = 0;
  group.columns["s"].pages[0].min_exact = false;
  group.columns["s"].pages[0].max_exact = false;
  group.columns["s"].page_locations[0].first_row_index = 0;
  group.num_rows = 20;

  {
    const PruneResult result = dataeng::prune(group, Predicate::ne("n", i64(5)));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(result.candidate_rows.front().begin, 10);
    CHECK_EQ(result.candidate_rows.front().end, 20);
  }

  {
    // Truncated bounds may not prove equality or inequality.
    const PruneResult result = dataeng::prune(group, Predicate::ne("s", Value::string("abc")));
    CHECK(result.containsRow(0));
  }
  {
    const PruneResult result = dataeng::prune(group, Predicate::eq("s", Value::string("abc")));
    CHECK(result.containsRow(0));
  }
  {
    // Both directional range proofs remain valid for truncated bounds.
    const PruneResult result =
        dataeng::prune(group, Predicate::lt("s", Value::string("zzz")));
    CHECK_EQ(result.candidateRowCount(), 20);

    const PruneResult impossible =
        dataeng::prune(group, Predicate::gt("s", Value::string("zzz")));
    CHECK(impossible.candidate_rows.empty());
  }

  {
    // Even equal truncated bounds cannot prove equality: the real values may
    // all share a longer prefix.
    RowGroupIndex truncated = rowGroup(
        10, {{"t", column({stats(Value::string("abc"), Value::string("abc"))},
                          {0})}});
    truncated.columns["t"].pages[0].min_exact = false;
    truncated.columns["t"].pages[0].max_exact = false;
    const PruneResult ne =
        dataeng::prune(truncated, Predicate::ne("t", Value::string("abc")));
    CHECK_EQ(ne.candidateRowCount(), 10);
    const PruneResult eq =
        dataeng::prune(truncated, Predicate::eq("t", Value::string("abc")));
    CHECK_EQ(eq.candidateRowCount(), 10);
  }
  {
    // The Parquet adapter defaults binary bounds to non-exact because the
    // format has no truncation flag.
    dataeng::ParquetColumnIndex raw;
    raw.null_pages = {false};
    raw.min_values = {Value::string("abc")};
    raw.max_values = {Value::string("abc")};
    raw.null_counts = {std::int64_t{0}};
    PageLocation location;
    location.first_row_index = 0;
    dataeng::ParquetOffsetIndex offsets{{location}};
    ColumnPageIndex parsed = ColumnPageIndex::from(raw, offsets);
    CHECK(!parsed.pages[0].min_exact);
    CHECK(!parsed.pages[0].max_exact);
    RowGroupIndex group = rowGroup(10, {{"t", std::move(parsed)}});
    const PruneResult result =
        dataeng::prune(group, Predicate::ne("t", Value::string("abc")));
    CHECK_EQ(result.candidateRowCount(), 10);
  }
}

void testNullPages() {
  RowGroupIndex group = rowGroup(
      30, {{"a", column({stats(i64(0), i64(9), 0, false),
                          stats(std::nullopt, std::nullopt, std::nullopt, true),
                          stats(i64(20), i64(29), 0, false)},
                         {0, 10, 20})}});

  {
    const PruneResult result = dataeng::prune(group, Predicate::gt("a", i64(5)));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{2});
    CHECK_EQ(result.candidate_rows[0].begin, 0);
    CHECK_EQ(result.candidate_rows[0].end, 10);
    CHECK_EQ(result.candidate_rows[1].begin, 20);
    CHECK_EQ(result.candidate_rows[1].end, 30);
    CHECK(!result.isPageCandidate("a", 1));
  }
  {
    const PruneResult result = dataeng::prune(group, Predicate::isNull("a"));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(result.candidate_rows.front().begin, 10);
    CHECK_EQ(result.candidate_rows.front().end, 20);
  }
  {
    const PruneResult result = dataeng::prune(group, Predicate::isNotNull("a"));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{2});
    CHECK_EQ(result.candidate_rows[0].begin, 0);
    CHECK_EQ(result.candidate_rows[1].begin, 20);
  }
  {
    const PruneResult result = dataeng::prune(group, !Predicate::isNull("a"));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{2});
    CHECK_EQ(result.candidate_rows[0].begin, 0);
    CHECK_EQ(result.candidate_rows[1].begin, 20);
  }
  {
    const PruneResult result = dataeng::prune(group, !Predicate::isNotNull("a"));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(result.candidate_rows.front().begin, 10);
  }
}

void testMultiColumnAndOr() {
  RowGroupIndex group = rowGroup(
      20, {{"a", column({stats(i64(0), i64(9)), stats(i64(10), i64(19))},
                         {0, 10})},
            {"b", column({stats(i64(0), i64(4)), stats(i64(5), i64(14)),
                          stats(i64(15), i64(19))},
                         {0, 5, 15})}});

  {
    const PruneResult result =
        dataeng::prune(group, Predicate::all({Predicate::ge("a", i64(10)),
                                              Predicate::ge("b", i64(10))}));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(result.candidate_rows.front().begin, 10);
    CHECK_EQ(result.candidate_rows.front().end, 20);
    CHECK(!result.isPageCandidate("a", 0));
    CHECK(result.isPageCandidate("a", 1));
    CHECK(!result.isPageCandidate("b", 0));
    CHECK(result.isPageCandidate("b", 1));
    CHECK(result.isPageCandidate("b", 2));
  }
  {
    const PruneResult result =
        dataeng::prune(group, Predicate::any({Predicate::ge("a", i64(10)),
                                              Predicate::ge("b", i64(10))}));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(result.candidate_rows.front().begin, 5);
    CHECK_EQ(result.candidate_rows.front().end, 20);
  }
  {
    // FALSE AND UNKNOWN is FALSE; FALSE OR UNKNOWN is UNKNOWN.
    RowGroupIndex missing = rowGroup(
        20, {{"a", column({stats(i64(0), i64(9)), stats(i64(10), i64(19))},
                           {0, 10})},
             {"b", column({}, {})}});
    const PruneResult and_result =
        dataeng::prune(missing, Predicate::all({Predicate::ge("a", i64(10)),
                                                Predicate::ge("b", i64(10))}));
    CHECK_EQ(and_result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(and_result.candidate_rows.front().begin, 10);
    CHECK_EQ(and_result.candidate_rows.front().end, 20);

    const PruneResult or_result =
        dataeng::prune(missing, Predicate::any({Predicate::ge("a", i64(10)),
                                                Predicate::ge("b", i64(10))}));
    CHECK_EQ(or_result.candidateRowCount(), 20);
  }
}

void testCorruptionFallback() {
  {
    ColumnPageIndex col = column({stats(i64(0), i64(9)), stats(i64(10), i64(19))},
                                 {0});
    RowGroupIndex group = rowGroup(20, {{"a", std::move(col)}});
    const PruneResult result = dataeng::prune(group, Predicate::eq("a", i64(5)));
    CHECK_EQ(result.status, PruneStatus::CorruptIndex);
    CHECK(result.fallback);
    CHECK(result.containsRow(0));
    CHECK(result.containsRow(19));
    CHECK(result.isPageCandidate("a", 0));
    CHECK(result.isPageCandidate("a", 1));
  }
  {
    RowGroupIndex group =
        rowGroup(10, {{"a", column({stats(i64(10), i64(5))}, {0})}});
    const PruneResult result = dataeng::prune(group, Predicate::eq("a", i64(7)));
    CHECK_EQ(result.status, PruneStatus::CorruptIndex);
    CHECK_EQ(result.candidateRowCount(), 10);
  }
  {
    RowGroupIndex group =
        rowGroup(30, {{"a", column({stats(i64(0), i64(9)), stats(i64(20), i64(29)),
                                    stats(i64(10), i64(19))},
                                   {0, 10, 20}, BoundaryOrder::Ascending)}});
    const PruneResult result = dataeng::prune(group, Predicate::eq("a", i64(5)));
    CHECK_EQ(result.status, PruneStatus::CorruptIndex);
    CHECK_EQ(result.candidateRowCount(), 30);
  }
  {
    dataeng::ParquetColumnIndex raw;
    raw.null_pages = {false, false};
    raw.min_values = {i64(0)};
    raw.max_values = {i64(9), i64(19)};
    ColumnPageIndex col =
        ColumnPageIndex::from(raw, dataeng::ParquetOffsetIndex{});
    CHECK(!col.malformed_reason.empty());
    RowGroupIndex group = rowGroup(20, {{"a", std::move(col)}});
    const PruneResult result = dataeng::prune(group, Predicate::eq("a", i64(5)));
    CHECK_EQ(result.status, PruneStatus::CorruptIndex);
    CHECK_EQ(result.candidateRowCount(), 20);
  }
}

void testMissingStatistics() {
  RowGroupIndex group = rowGroup(
      20, {{"a", column({stats(std::nullopt, std::nullopt),
                         stats(std::nullopt, std::nullopt)},
                        {0, 10})}});
  const PruneResult result = dataeng::prune(group, Predicate::eq("a", i64(5)));
  CHECK_EQ(result.status, PruneStatus::Ok);
  CHECK_EQ(result.candidateRowCount(), 20);
  CHECK(result.has_unknown);

  const PruneResult missing_column =
      dataeng::prune(group, Predicate::eq("not_there", i64(5)));
  CHECK_EQ(missing_column.status, PruneStatus::Ok);
  CHECK_EQ(missing_column.candidateRowCount(), 20);
  CHECK(missing_column.has_unknown);
}

void testMissingOffsetIndex() {
  ColumnPageIndex col;
  col.pages = {stats(i64(0), i64(9)), stats(i64(10), i64(19))};
  RowGroupIndex group = rowGroup(20, {{"a", std::move(col)}});
  const PruneResult result = dataeng::prune(group, Predicate::eq("a", i64(5)));
  CHECK_EQ(result.status, PruneStatus::Ok);
  CHECK_EQ(result.candidateRowCount(), 20);
  CHECK(result.has_unknown);
  CHECK(result.isPageCandidate("a", 0));
  CHECK(result.isPageCandidate("a", 1));
}

void testNestedRepetition() {
  {
    // Page 0 includes the beginning of record 5; page 1 continues record 5.
    // Page 1 cannot match, but page 0 can, so row 5 must survive.
    ColumnPageIndex rep = column(
        {stats(i64(0), i64(10)), stats(i64(0), i64(9))}, {0, 5},
        BoundaryOrder::Unordered, 1, 2);
    rep.page_locations[1].first_repetition_level = 1;
    RowGroupIndex group = rowGroup(10, {{"r", std::move(rep)}});
    const PruneResult result = dataeng::prune(group, Predicate::ge("r", i64(10)));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(result.candidate_rows.front().begin, 0);
    CHECK_EQ(result.candidate_rows.front().end, 6);
    CHECK(result.containsRow(5));
    CHECK(result.isPageCandidate("r", 0));
    CHECK(result.isPageCandidate("r", 1));
  }
  {
    // The mirror case: only page 1 can match, and it starts in record 5.
    ColumnPageIndex rep = column(
        {stats(i64(0), i64(9)), stats(i64(10), i64(20))}, {0, 5},
        BoundaryOrder::Unordered, 1, 2);
    rep.page_locations[1].first_repetition_level = 1;
    RowGroupIndex group = rowGroup(10, {{"r", std::move(rep)}});
    const PruneResult result = dataeng::prune(group, Predicate::ge("r", i64(10)));
    CHECK_EQ(result.candidate_rows.size(), std::size_t{1});
    CHECK_EQ(result.candidate_rows.front().begin, 5);
    CHECK_EQ(result.candidate_rows.front().end, 10);
    CHECK(result.containsRow(5));
    CHECK(result.isPageCandidate("r", 0));
    CHECK(result.isPageCandidate("r", 1));
  }
  {
    // Unknown first repetition level: share the boundary row conservatively.
    ColumnPageIndex rep = column(
        {stats(i64(0), i64(9)), stats(i64(10), i64(20))}, {0, 5},
        BoundaryOrder::Unordered, 1, 2);
    RowGroupIndex group = rowGroup(10, {{"r", std::move(rep)}});
    const PruneResult result = dataeng::prune(group, Predicate::ge("r", i64(10)));
    CHECK(result.containsRow(5));

    dataeng::PruneOptions conservative;
    conservative.allow_repeated_pruning = false;
    const PruneResult disabled = dataeng::prune(
        group, Predicate::ge("r", i64(10)), conservative);
    CHECK_EQ(disabled.candidateRowCount(), 10);
    CHECK(disabled.has_unknown);
  }
}

void testBoundaryOrder() {
  RowGroupIndex ascending = rowGroup(
      30, {{"a", column({stats(i64(0), i64(9)), stats(i64(10), i64(19)),
                         stats(i64(20), i64(29))},
                        {0, 10, 20}, BoundaryOrder::Ascending)}});
  CHECK(!dataeng::validateRowGroupIndex(ascending).has_value());

  RowGroupIndex descending = rowGroup(
      30, {{"a", column({stats(i64(20), i64(29)), stats(i64(10), i64(19)),
                         stats(i64(0), i64(9))},
                        {0, 10, 20}, BoundaryOrder::Descending)}});
  CHECK(!dataeng::validateRowGroupIndex(descending).has_value());

  RowGroupIndex bad = rowGroup(
      30, {{"a", column({stats(i64(0), i64(9)), stats(i64(20), i64(29)),
                         stats(i64(10), i64(19))},
                        {0, 10, 20}, BoundaryOrder::Ascending)}});
  CHECK(dataeng::validateRowGroupIndex(bad).has_value());
}

enum class Tri : std::uint8_t { False, Unknown, True };

Tri triAnd(Tri lhs, Tri rhs) {
  if (lhs == Tri::False || rhs == Tri::False) {
    return Tri::False;
  }
  if (lhs == Tri::True && rhs == Tri::True) {
    return Tri::True;
  }
  return Tri::Unknown;
}

Tri triOr(Tri lhs, Tri rhs) {
  if (lhs == Tri::True || rhs == Tri::True) {
    return Tri::True;
  }
  if (lhs == Tri::False && rhs == Tri::False) {
    return Tri::False;
  }
  return Tri::Unknown;
}

Tri triNot(Tri value) {
  if (value == Tri::True) {
    return Tri::False;
  }
  if (value == Tri::False) {
    return Tri::True;
  }
  return Tri::Unknown;
}

bool compareOk(std::int64_t lhs, CompareOp op, std::int64_t rhs) {
  switch (op) {
    case CompareOp::Eq:
      return lhs == rhs;
    case CompareOp::NotEq:
      return lhs != rhs;
    case CompareOp::Lt:
      return lhs < rhs;
    case CompareOp::Le:
      return lhs <= rhs;
    case CompareOp::Gt:
      return lhs > rhs;
    case CompareOp::Ge:
      return lhs >= rhs;
  }
  return false;
}

bool compareOk(const std::string& lhs, CompareOp op, const std::string& rhs) {
  switch (op) {
    case CompareOp::Eq:
      return lhs == rhs;
    case CompareOp::NotEq:
      return lhs != rhs;
    case CompareOp::Lt:
      return lhs < rhs;
    case CompareOp::Le:
      return lhs <= rhs;
    case CompareOp::Gt:
      return lhs > rhs;
    case CompareOp::Ge:
      return lhs >= rhs;
  }
  return false;
}

Tri triCompare(const std::optional<std::int64_t>& value, CompareOp op,
               std::int64_t constant) {
  if (!value.has_value()) {
    return Tri::Unknown;
  }
  return compareOk(*value, op, constant) ? Tri::True : Tri::False;
}

Tri evalRow(const Predicate& predicate,
            const std::map<std::string, std::optional<std::int64_t>>& row) {
  switch (predicate.kind()) {
    case Predicate::Kind::True:
      return Tri::True;
    case Predicate::Kind::False:
      return Tri::False;
    case Predicate::Kind::Compare: {
      const auto it = row.find(predicate.column());
      if (it == row.end()) {
        return Tri::Unknown;
      }
      return triCompare(it->second, predicate.compareOp(),
                        std::get<std::int64_t>(predicate.value().storage()));
    }
    case Predicate::Kind::IsNull: {
      const auto it = row.find(predicate.column());
      if (it == row.end()) {
        return Tri::Unknown;
      }
      return it->second.has_value() ? Tri::False : Tri::True;
    }
    case Predicate::Kind::IsNotNull: {
      const auto it = row.find(predicate.column());
      if (it == row.end()) {
        return Tri::Unknown;
      }
      return it->second.has_value() ? Tri::True : Tri::False;
    }
    case Predicate::Kind::And:
      return triAnd(evalRow(predicate.children()[0], row),
                    evalRow(predicate.children()[1], row));
    case Predicate::Kind::Or:
      return triOr(evalRow(predicate.children()[0], row),
                   evalRow(predicate.children()[1], row));
    case Predicate::Kind::Not:
      return triNot(evalRow(predicate.children()[0], row));
  }
  return Tri::Unknown;
}

struct RandomGroup {
  RowGroupIndex group;
  std::vector<std::map<std::string, std::optional<std::int64_t>>> rows;
};

struct RepeatedRow {
  std::vector<std::int64_t> values;
  bool has_null = false;
};

struct RandomRepeatedGroup {
  RowGroupIndex group;
  std::vector<RepeatedRow> rows;
};

RandomGroup makeRandomGroup(std::mt19937& rng) {
  std::uniform_int_distribution<int> rows_dist(1, 80);
  std::uniform_int_distribution<int> pages_dist(1, 6);
  std::uniform_int_distribution<int> value_dist(-20, 20);
  std::uniform_int_distribution<int> null_percent(0, 100);

  const int num_rows = rows_dist(rng);
  const int num_pages = std::min(num_rows, pages_dist(rng));
  std::vector<int> boundaries;
  boundaries.push_back(0);
  for (int i = 1; i < num_pages; ++i) {
    boundaries.push_back(i * num_rows / num_pages);
  }
  boundaries.push_back(num_rows);

  RandomGroup result;
  result.group.num_rows = num_rows;
  result.rows.resize(static_cast<std::size_t>(num_rows));

  for (const std::string name : {"a", "b"}) {
    ColumnPageIndex col;
    for (std::size_t page_index = 0;
         page_index + 1 < boundaries.size(); ++page_index) {
      const int begin = boundaries[page_index];
      const int end = boundaries[page_index + 1];
      std::optional<std::int64_t> min_value;
      std::optional<std::int64_t> max_value;
      std::int64_t null_count = 0;
      bool all_null = true;
      for (int row = begin; row < end; ++row) {
        std::optional<std::int64_t> value;
        if (null_percent(rng) >= 25) {
          value = value_dist(rng);
          all_null = false;
          if (!min_value.has_value() || *value < *min_value) {
            min_value = value;
          }
          if (!max_value.has_value() || *value > *max_value) {
            max_value = value;
          }
        } else {
          ++null_count;
        }
        result.rows[static_cast<std::size_t>(row)][name] = value;
      }
      PageStatistics page;
      page.null_page = all_null;
      page.null_count = null_count;
      if (!all_null) {
        page.min_value = i64(*min_value);
        page.max_value = i64(*max_value);
      }
      col.pages.push_back(page);
      PageLocation location;
      location.first_row_index = begin;
      col.page_locations.push_back(location);
    }
    col.boundary_order = BoundaryOrder::Unordered;
    result.group.columns.emplace(name, std::move(col));
  }
  return result;
}

RandomRepeatedGroup makeRandomRepeatedGroup(std::mt19937& rng) {
  std::uniform_int_distribution<int> rows_dist(2, 35);
  std::uniform_int_distribution<int> pages_dist(1, 8);
  std::uniform_int_distribution<int> value_dist(-20, 20);
  std::uniform_int_distribution<int> null_percent(0, 100);
  std::uniform_int_distribution<int> share_percent(0, 100);

  const int num_rows = rows_dist(rng);
  const int requested_pages = std::min(num_rows + 3, pages_dist(rng));

  std::vector<int> first_rows;
  std::vector<int> first_reps;
  int row = 0;
  for (int page = 0; page < requested_pages; ++page) {
    if (page != 0) {
      if (share_percent(rng) < 25) {
        // A second page starting in the same record.
      } else {
        row = std::min(num_rows - 1,
                       row + 1 + static_cast<int>(rng() % 4));
      }
    }
    first_rows.push_back(row);
    const std::size_t index = static_cast<std::size_t>(page);
    first_reps.push_back(
        page == 0
            ? 0
            : (first_rows[index] == first_rows[index - 1] ? 1 : 0));
  }
  // Ensure every page starts before the end of the row group.
  for (int page = 1; page < requested_pages; ++page) {
    const std::size_t index = static_cast<std::size_t>(page);
    if (first_rows[index] == first_rows[index - 1]) {
      first_reps[index] = 1;
    }
  }

  RandomRepeatedGroup result;
  result.group.num_rows = num_rows;
  result.rows.resize(static_cast<std::size_t>(num_rows));

  ColumnPageIndex col;
  col.max_repetition_level = 1;
  col.max_definition_level = 2;
  for (int page = 0; page < requested_pages; ++page) {
    const std::size_t index = static_cast<std::size_t>(page);
    const int begin = first_rows[index];
    int end = num_rows;
    if (page + 1 < requested_pages) {
      end = first_rows[index + 1];
      if (first_reps[index + 1] > 0 && end < num_rows) {
        ++end;
      }
    }

    std::optional<std::int64_t> min_value;
    std::optional<std::int64_t> max_value;
    std::int64_t null_count = 0;
    bool all_null = true;
    for (int current_row = begin; current_row < end; ++current_row) {
      const int copies = 1 + static_cast<int>(rng() % 2);
      for (int copy = 0; copy < copies; ++copy) {
        if (null_percent(rng) < 20) {
          ++null_count;
          result.rows[static_cast<std::size_t>(current_row)].has_null = true;
        } else {
          const std::int64_t value = value_dist(rng);
          all_null = false;
          result.rows[static_cast<std::size_t>(current_row)].values.push_back(
              value);
          if (!min_value.has_value() || value < *min_value) {
            min_value = value;
          }
          if (!max_value.has_value() || value > *max_value) {
            max_value = value;
          }
        }
      }
    }

    PageStatistics page_stats;
    page_stats.null_page = all_null;
    page_stats.null_count = null_count;
    if (!all_null) {
      page_stats.min_value = i64(*min_value);
      page_stats.max_value = i64(*max_value);
    }
    col.pages.push_back(page_stats);

    PageLocation location;
    location.first_row_index = begin;
    location.first_repetition_level = first_reps[index];
    col.page_locations.push_back(location);
  }
  result.group.columns.emplace("r", std::move(col));
  return result;
}

bool repeatedRowMatches(const Predicate& predicate, const RepeatedRow& row) {
  switch (predicate.kind()) {
    case Predicate::Kind::True:
      return true;
    case Predicate::Kind::False:
      return false;
    case Predicate::Kind::Compare: {
      const std::int64_t constant =
          std::get<std::int64_t>(predicate.value().storage());
      for (std::int64_t value : row.values) {
        if (compareOk(value, predicate.compareOp(), constant)) {
          return true;
        }
      }
      return false;
    }
    case Predicate::Kind::IsNull:
      return row.has_null;
    case Predicate::Kind::IsNotNull:
      return !row.values.empty();
    case Predicate::Kind::And:
      return repeatedRowMatches(predicate.children()[0], row) &&
             repeatedRowMatches(predicate.children()[1], row);
    case Predicate::Kind::Or:
      return repeatedRowMatches(predicate.children()[0], row) ||
             repeatedRowMatches(predicate.children()[1], row);
    case Predicate::Kind::Not:
      return !repeatedRowMatches(predicate.children()[0], row);
  }
  return false;
}

void testRandomizedNoFalseNegatives() {
  std::mt19937 rng(0x5eed1234u);
  std::uniform_int_distribution<int> op_dist(0, 5);
  std::uniform_int_distribution<int> value_dist(-25, 25);
  std::uniform_int_distribution<int> kind_dist(0, 5);

  const CompareOp ops[] = {CompareOp::Eq,  CompareOp::NotEq, CompareOp::Lt,
                           CompareOp::Le,  CompareOp::Gt,    CompareOp::Ge};

  for (int iteration = 0; iteration < 1000; ++iteration) {
    RandomGroup data = makeRandomGroup(rng);
    const CompareOp op_a = ops[op_dist(rng)];
    const CompareOp op_b = ops[op_dist(rng)];
    const std::int64_t value_a = value_dist(rng);
    const std::int64_t value_b = value_dist(rng);

    Predicate predicate;
    switch (kind_dist(rng)) {
      case 0:
        predicate = Predicate::compare("a", op_a, i64(value_a));
        break;
      case 1:
        predicate = Predicate::all({Predicate::compare("a", op_a, i64(value_a)),
                                    Predicate::compare("b", op_b, i64(value_b))});
        break;
      case 2:
        predicate = Predicate::any({Predicate::compare("a", op_a, i64(value_a)),
                                    Predicate::compare("b", op_b, i64(value_b))});
        break;
      case 3:
        predicate = Predicate::all(
            {Predicate::isNull("a"),
             Predicate::any({Predicate::isNotNull("b"),
                             Predicate::compare("a", op_a, i64(value_a))})});
        break;
      case 4:
        predicate = !Predicate::any(
            {Predicate::compare("a", op_a, i64(value_a)),
             Predicate::isNull("b")});
        break;
      default:
        predicate = Predicate::any(
            {Predicate::compare("a", op_a, i64(value_a)),
             Predicate::all({Predicate::compare("b", op_b, i64(value_b)),
                             Predicate::isNotNull("a")})});
        break;
    }

    const PruneResult result = dataeng::prune(data.group, predicate);
    CHECK_EQ(result.status, PruneStatus::Ok);
    for (int row = 0; row < data.group.num_rows; ++row) {
      if (evalRow(predicate, data.rows[static_cast<std::size_t>(row)]) ==
          Tri::True) {
        if (!result.containsRow(row)) {
          std::cerr << "false negative at iteration " << iteration << ", row "
                    << row << "\n";
          CHECK(result.containsRow(row));
        }
      }
    }
  }
}

void testRandomizedRepeatedNoFalseNegatives() {
  std::mt19937 rng(0xc0ffeeu);
  std::uniform_int_distribution<int> op_dist(0, 5);
  std::uniform_int_distribution<int> value_dist(-25, 25);
  std::uniform_int_distribution<int> kind_dist(0, 5);
  const CompareOp ops[] = {CompareOp::Eq,  CompareOp::NotEq, CompareOp::Lt,
                           CompareOp::Le,  CompareOp::Gt,    CompareOp::Ge};

  for (int iteration = 0; iteration < 1000; ++iteration) {
    RandomRepeatedGroup data = makeRandomRepeatedGroup(rng);
    const CompareOp op_a = ops[op_dist(rng)];
    const CompareOp op_b = ops[op_dist(rng)];
    const std::int64_t value_a = value_dist(rng);
    const std::int64_t value_b = value_dist(rng);

    Predicate predicate;
    switch (kind_dist(rng)) {
      case 0:
        predicate = Predicate::compare("r", op_a, i64(value_a));
        break;
      case 1:
        predicate = Predicate::all(
            {Predicate::compare("r", op_a, i64(value_a)),
             Predicate::compare("r", op_b, i64(value_b))});
        break;
      case 2:
        predicate = Predicate::any(
            {Predicate::compare("r", op_a, i64(value_a)),
             Predicate::compare("r", op_b, i64(value_b))});
        break;
      case 3:
        predicate = Predicate::all({Predicate::isNotNull("r"),
                                    Predicate::compare("r", op_a, i64(value_a))});
        break;
      case 4:
        predicate = Predicate::any(
            {Predicate::isNull("r"),
             Predicate::compare("r", op_a, i64(value_a))});
        break;
      default:
        predicate = Predicate::any(
            {Predicate::all({Predicate::isNull("r"),
                             Predicate::compare("r", op_a, i64(value_a))}),
             Predicate::compare("r", op_b, i64(value_b))});
        break;
    }

    const PruneResult result = dataeng::prune(data.group, predicate);
    CHECK_EQ(result.status, PruneStatus::Ok);
    for (int row = 0; row < data.group.num_rows; ++row) {
      if (repeatedRowMatches(
              predicate, data.rows[static_cast<std::size_t>(row)]) &&
          !result.containsRow(row)) {
        std::cerr << "repeated false negative at iteration " << iteration
                  << ", row " << row << "\n";
        CHECK(result.containsRow(row));
      }
    }
  }
}

std::string randomWord(std::mt19937& rng, int min_length, int max_length) {
  std::uniform_int_distribution<int> length_dist(min_length, max_length);
  std::uniform_int_distribution<int> char_dist(0, 25);
  const int length = length_dist(rng);
  std::string word;
  word.reserve(static_cast<std::size_t>(length));
  for (int i = 0; i < length; ++i) {
    word.push_back(static_cast<char>('a' + char_dist(rng)));
  }
  return word;
}

void testRandomizedTruncatedBounds() {
  std::mt19937 rng(0xabad1deau);
  std::uniform_int_distribution<int> rows_dist(1, 60);
  std::uniform_int_distribution<int> pages_dist(1, 5);
  std::uniform_int_distribution<int> null_percent(0, 100);
  std::uniform_int_distribution<int> op_dist(0, 5);
  const CompareOp ops[] = {CompareOp::Eq,  CompareOp::NotEq, CompareOp::Lt,
                           CompareOp::Le,  CompareOp::Gt,    CompareOp::Ge};

  for (int iteration = 0; iteration < 500; ++iteration) {
    const int num_rows = rows_dist(rng);
    const int num_pages = std::min(num_rows, pages_dist(rng));
    std::vector<int> boundaries;
    boundaries.push_back(0);
    for (int page = 1; page < num_pages; ++page) {
      boundaries.push_back(page * num_rows / num_pages);
    }
    boundaries.push_back(num_rows);

    RowGroupIndex group;
    group.num_rows = num_rows;
    std::vector<std::optional<std::string>> values(
        static_cast<std::size_t>(num_rows));
    ColumnPageIndex col;

    for (std::size_t page = 0; page + 1 < boundaries.size(); ++page) {
      const int begin = boundaries[page];
      const int end = boundaries[page + 1];
      std::optional<std::string> actual_min;
      std::optional<std::string> actual_max;
      std::int64_t null_count = 0;
      for (int row = begin; row < end; ++row) {
        std::optional<std::string> value;
        if (null_percent(rng) >= 20) {
          value = randomWord(rng, 1, 8);
          if (!actual_min.has_value() || *value < *actual_min) {
            actual_min = value;
          }
          if (!actual_max.has_value() || *value > *actual_max) {
            actual_max = value;
          }
        } else {
          ++null_count;
        }
        values[static_cast<std::size_t>(row)] = value;
      }

      PageStatistics page_stats;
      page_stats.null_page = !actual_min.has_value();
      page_stats.null_count = null_count;
      if (actual_min.has_value()) {
        constexpr std::size_t kTruncate = 3;
        std::string min_bound = *actual_min;
        std::string max_bound = *actual_max;
        if (min_bound.size() > kTruncate) {
          min_bound.resize(kTruncate);
          page_stats.min_exact = false;
        }
        if (max_bound.size() > kTruncate) {
          max_bound.resize(kTruncate);
          // A byte larger than any possible suffix keeps this an upper bound.
          max_bound.push_back(static_cast<char>(0xFF));
          page_stats.max_exact = false;
        }
        page_stats.min_value = Value::string(std::move(min_bound));
        page_stats.max_value = Value::string(std::move(max_bound));
      }
      col.pages.push_back(page_stats);
      PageLocation location;
      location.first_row_index = begin;
      col.page_locations.push_back(location);
    }
    group.columns.emplace("s", std::move(col));

    std::string constant = randomWord(rng, 1, 9);
    if ((rng() % 3) == 0) {
      const auto& first_page = group.columns["s"].pages[0];
      if (first_page.min_value.has_value()) {
        constant = std::get<std::string>(first_page.min_value->storage());
      }
    }
    const CompareOp op = ops[op_dist(rng)];
    const Predicate predicate = Predicate::compare("s", op,
                                                   Value::string(constant));
    const PruneResult result = dataeng::prune(group, predicate);
    CHECK_EQ(result.status, PruneStatus::Ok);

    for (int row = 0; row < num_rows; ++row) {
      const auto& value = values[static_cast<std::size_t>(row)];
      if (!value.has_value()) {
        continue;
      }
      const bool matches = compareOk(*value, op, constant);
      if (matches) {
        CHECK(result.containsRow(row));
      }
    }
  }
}

void testEmptyRowGroup() {
  RowGroupIndex group =
      rowGroup(0, {{"a", column({stats(i64(0), i64(0))}, {0})}});
  const PruneResult result = dataeng::prune(group, Predicate::eq("a", i64(0)));
  CHECK_EQ(result.status, PruneStatus::Ok);
  CHECK(result.candidate_rows.empty());
  CHECK(!result.isPageCandidate("a", 0));
}

void testPrunerFacade() {
  RowGroupIndex group =
      rowGroup(10, {{"a", column({stats(i64(0), i64(9))}, {0})}});
  dataeng::PageIndexPruner pruner(group);
  const PruneResult result = pruner.prune(Predicate::eq("a", i64(5)));
  CHECK_EQ(result.candidateRowCount(), 10);
}

void testValueComparison() {
  CHECK(Value::int32(3) == Value::int64(3));
  CHECK(Value::int32(3) < Value::int64(4));
  CHECK(Value::float32(1.5f) == Value::float64(1.5));
  CHECK(Value::string("abc") < Value::string("abd"));
  CHECK(Value::string("abc") < Value::string("abcd"));
  CHECK(Value::string("abc") ==
        Value::fixedLenByteArray({std::uint8_t{'a'}, std::uint8_t{'b'},
                                  std::uint8_t{'c'}}));
  CHECK((Value::int64(1).compare(Value::string("x")) ==
         std::partial_ordering::unordered));
}

}  // namespace

int main() {
  testValueComparison();
  testBasicFlatPruning();
  testExactEqualityAndTruncation();
  testNullPages();
  testMultiColumnAndOr();
  testCorruptionFallback();
  testMissingStatistics();
  testMissingOffsetIndex();
  testNestedRepetition();
  testBoundaryOrder();
  testRandomizedNoFalseNegatives();
  testRandomizedRepeatedNoFalseNegatives();
  testRandomizedTruncatedBounds();
  testPrunerFacade();
  testEmptyRowGroup();

  if (g_failures != 0) {
    std::cerr << g_failures << " test checks failed\n";
    return 1;
  }
  std::cout << "all page-index pruning tests passed\n";
  return 0;
}
