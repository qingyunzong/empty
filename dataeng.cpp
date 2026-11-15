#include "dataeng.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <set>
#include <sstream>
#include <utility>

namespace dataeng {

namespace {

bool isNaNScalar(const Value& value) {
  if (value.kind() == Value::Kind::Float) {
    return std::isnan(std::get<float>(value.storage()));
  }
  if (value.kind() == Value::Kind::Double) {
    return std::isnan(std::get<double>(value.storage()));
  }
  return false;
}

struct ByteView {
  const std::uint8_t* data = nullptr;
  std::size_t size = 0;
};

std::optional<ByteView> byteView(const Value& value) {
  switch (value.kind()) {
    case Value::Kind::String: {
      const auto& text = std::get<std::string>(value.storage());
      return ByteView{reinterpret_cast<const std::uint8_t*>(text.data()),
                      text.size()};
    }
    case Value::Kind::Binary:
    case Value::Kind::FixedLenByteArray: {
      const auto& bytes = std::get<Value::Bytes>(value.storage());
      return ByteView{bytes.data(), bytes.size()};
    }
    case Value::Kind::Int96: {
      const auto& bytes = std::get<Value::Int96Bytes>(value.storage());
      return ByteView{bytes.data(), bytes.size()};
    }
    default:
      return std::nullopt;
  }
}

int compareBytes(ByteView lhs, ByteView rhs) {
  const std::size_t common = std::min(lhs.size, rhs.size);
  if (common != 0) {
    const int result = std::memcmp(lhs.data, rhs.data, common);
    if (result < 0) {
      return -1;
    }
    if (result > 0) {
      return 1;
    }
  }
  if (lhs.size < rhs.size) {
    return -1;
  }
  if (lhs.size > rhs.size) {
    return 1;
  }
  return 0;
}

std::partial_ordering orderingFromInt(int value) {
  if (value < 0) {
    return std::partial_ordering::less;
  }
  if (value > 0) {
    return std::partial_ordering::greater;
  }
  return std::partial_ordering::equivalent;
}

}  // namespace

Value Value::boolean(bool value) {
  return Value(Kind::Boolean, Storage(value));
}

Value Value::int32(std::int32_t value) {
  return Value(Kind::Int32, Storage(value));
}

Value Value::int64(std::int64_t value) {
  return Value(Kind::Int64, Storage(value));
}

Value Value::float32(float value) {
  return Value(Kind::Float, Storage(value));
}

Value Value::float64(double value) {
  return Value(Kind::Double, Storage(value));
}

Value Value::string(std::string value) {
  return Value(Kind::String, Storage(std::move(value)));
}

Value Value::binary(Bytes value) {
  return Value(Kind::Binary, Storage(std::move(value)));
}

Value Value::fixedLenByteArray(Bytes value) {
  return Value(Kind::FixedLenByteArray, Storage(std::move(value)));
}

Value Value::int96(Int96Bytes value) {
  return Value(Kind::Int96, Storage(value));
}

PhysicalType Value::physicalType() const {
  switch (kind_) {
    case Kind::Boolean:
      return PhysicalType::Boolean;
    case Kind::Int32:
      return PhysicalType::Int32;
    case Kind::Int64:
      return PhysicalType::Int64;
    case Kind::Float:
      return PhysicalType::Float;
    case Kind::Double:
      return PhysicalType::Double;
    case Kind::Int96:
      return PhysicalType::Int96;
    case Kind::FixedLenByteArray:
      return PhysicalType::FixedLenByteArray;
    case Kind::String:
    case Kind::Binary:
    case Kind::Null:
      return PhysicalType::ByteArray;
  }
  return PhysicalType::ByteArray;
}

bool Value::isBinary() const {
  switch (kind_) {
    case Kind::String:
    case Kind::Binary:
    case Kind::FixedLenByteArray:
    case Kind::Int96:
      return true;
    default:
      return false;
  }
}

bool Value::isNumeric() const {
  switch (kind_) {
    case Kind::Int32:
    case Kind::Int64:
    case Kind::Float:
    case Kind::Double:
      return true;
    default:
      return false;
  }
}

std::partial_ordering Value::compare(const Value& other) const {
  if (kind_ == Kind::Null || other.kind_ == Kind::Null) {
    if (kind_ == other.kind_) {
      return std::partial_ordering::equivalent;
    }
    return std::partial_ordering::unordered;
  }

  if (kind_ == Kind::Boolean && other.kind_ == Kind::Boolean) {
    const bool lhs = std::get<bool>(storage_);
    const bool rhs = std::get<bool>(other.storage_);
    if (lhs == rhs) {
      return std::partial_ordering::equivalent;
    }
    return lhs ? std::partial_ordering::greater : std::partial_ordering::less;
  }

  const bool lhs_int = kind_ == Kind::Int32 || kind_ == Kind::Int64;
  const bool rhs_int =
      other.kind_ == Kind::Int32 || other.kind_ == Kind::Int64;
  if (lhs_int && rhs_int) {
    const std::int64_t lhs =
        kind_ == Kind::Int32 ? std::get<std::int32_t>(storage_)
                             : std::get<std::int64_t>(storage_);
    const std::int64_t rhs =
        other.kind_ == Kind::Int32
            ? std::get<std::int32_t>(other.storage_)
            : std::get<std::int64_t>(other.storage_);
    if (lhs < rhs) {
      return std::partial_ordering::less;
    }
    if (lhs > rhs) {
      return std::partial_ordering::greater;
    }
    return std::partial_ordering::equivalent;
  }

  const bool lhs_float = kind_ == Kind::Float || kind_ == Kind::Double;
  const bool rhs_float =
      other.kind_ == Kind::Float || other.kind_ == Kind::Double;
  if (lhs_float && rhs_float) {
    const double lhs = kind_ == Kind::Float
                           ? static_cast<double>(std::get<float>(storage_))
                           : std::get<double>(storage_);
    const double rhs =
        other.kind_ == Kind::Float
            ? static_cast<double>(std::get<float>(other.storage_))
            : std::get<double>(other.storage_);
    if (std::isnan(lhs) || std::isnan(rhs)) {
      return std::partial_ordering::unordered;
    }
    if (lhs < rhs) {
      return std::partial_ordering::less;
    }
    if (lhs > rhs) {
      return std::partial_ordering::greater;
    }
    return std::partial_ordering::equivalent;
  }

  const auto lhs_bytes = byteView(*this);
  const auto rhs_bytes = byteView(other);
  if (lhs_bytes.has_value() && rhs_bytes.has_value()) {
    return orderingFromInt(compareBytes(*lhs_bytes, *rhs_bytes));
  }

  return std::partial_ordering::unordered;
}

struct Predicate::Node {
  Kind kind = Kind::True;
  std::string column;
  CompareOp compare_op = CompareOp::Eq;
  Value value;
  std::vector<Predicate> children;
};

Predicate::Predicate() : node_(std::make_shared<const Node>()) {}

Predicate Predicate::constant(bool value) {
  auto node = std::make_shared<Node>();
  node->kind = value ? Kind::True : Kind::False;
  return Predicate(std::move(node));
}

Predicate Predicate::compare(std::string column, CompareOp op, Value value) {
  auto node = std::make_shared<Node>();
  node->kind = Kind::Compare;
  node->column = std::move(column);
  node->compare_op = op;
  node->value = std::move(value);
  return Predicate(std::move(node));
}

Predicate Predicate::isNull(std::string column) {
  auto node = std::make_shared<Node>();
  node->kind = Kind::IsNull;
  node->column = std::move(column);
  return Predicate(std::move(node));
}

Predicate Predicate::isNotNull(std::string column) {
  auto node = std::make_shared<Node>();
  node->kind = Kind::IsNotNull;
  node->column = std::move(column);
  return Predicate(std::move(node));
}

Predicate Predicate::all(std::vector<Predicate> predicates) {
  if (predicates.empty()) {
    return constant(true);
  }
  if (predicates.size() == 1) {
    return std::move(predicates.front());
  }
  auto node = std::make_shared<Node>();
  node->kind = Kind::And;
  node->children = std::move(predicates);
  return Predicate(std::move(node));
}

Predicate Predicate::any(std::vector<Predicate> predicates) {
  if (predicates.empty()) {
    return constant(false);
  }
  if (predicates.size() == 1) {
    return std::move(predicates.front());
  }
  auto node = std::make_shared<Node>();
  node->kind = Kind::Or;
  node->children = std::move(predicates);
  return Predicate(std::move(node));
}

Predicate Predicate::negate(Predicate predicate) {
  if (predicate.kind() == Kind::True) {
    return constant(false);
  }
  if (predicate.kind() == Kind::False) {
    return constant(true);
  }
  auto node = std::make_shared<Node>();
  node->kind = Kind::Not;
  node->children.push_back(std::move(predicate));
  return Predicate(std::move(node));
}

Predicate Predicate::eq(std::string column, Value value) {
  return compare(std::move(column), CompareOp::Eq, std::move(value));
}

Predicate Predicate::ne(std::string column, Value value) {
  return compare(std::move(column), CompareOp::NotEq, std::move(value));
}

Predicate Predicate::lt(std::string column, Value value) {
  return compare(std::move(column), CompareOp::Lt, std::move(value));
}

Predicate Predicate::le(std::string column, Value value) {
  return compare(std::move(column), CompareOp::Le, std::move(value));
}

Predicate Predicate::gt(std::string column, Value value) {
  return compare(std::move(column), CompareOp::Gt, std::move(value));
}

Predicate Predicate::ge(std::string column, Value value) {
  return compare(std::move(column), CompareOp::Ge, std::move(value));
}

Predicate::Kind Predicate::kind() const { return node_->kind; }

bool Predicate::isConstant() const {
  return kind() == Kind::True || kind() == Kind::False;
}

const std::string& Predicate::column() const { return node_->column; }

CompareOp Predicate::compareOp() const { return node_->compare_op; }

const Value& Predicate::value() const { return node_->value; }

const std::vector<Predicate>& Predicate::children() const {
  return node_->children;
}

std::vector<std::string> Predicate::referencedColumns() const {
  std::vector<std::string> result;
  std::set<std::string, std::less<>> seen;

  const auto visit = [&](const auto& self, const Predicate& predicate) -> void {
    switch (predicate.kind()) {
      case Kind::Compare:
      case Kind::IsNull:
      case Kind::IsNotNull:
        if (seen.insert(predicate.column()).second) {
          result.push_back(predicate.column());
        }
        return;
      case Kind::And:
      case Kind::Or:
      case Kind::Not:
        for (const auto& child : predicate.children()) {
          self(self, child);
        }
        return;
      case Kind::True:
      case Kind::False:
        return;
    }
  };

  visit(visit, *this);
  return result;
}

Predicate operator&&(Predicate lhs, Predicate rhs) {
  std::vector<Predicate> children;
  children.push_back(std::move(lhs));
  children.push_back(std::move(rhs));
  return Predicate::all(std::move(children));
}

Predicate operator||(Predicate lhs, Predicate rhs) {
  std::vector<Predicate> children;
  children.push_back(std::move(lhs));
  children.push_back(std::move(rhs));
  return Predicate::any(std::move(children));
}

Predicate operator!(Predicate predicate) {
  return Predicate::negate(std::move(predicate));
}

const ColumnPageIndex* RowGroupIndex::find(std::string_view column) const {
  const auto it = columns.find(column);
  return it == columns.end() ? nullptr : &it->second;
}

ColumnPageIndex ColumnPageIndex::from(const ParquetColumnIndex& column_index,
                                      const ParquetOffsetIndex& offset_index,
                                      std::int32_t max_repetition_level,
                                      std::int32_t max_definition_level) {
  ColumnPageIndex result;
  result.boundary_order = column_index.boundary_order;
  result.max_repetition_level = max_repetition_level;
  result.max_definition_level = max_definition_level;
  result.page_locations = offset_index.page_locations;

  const std::size_t page_count = column_index.null_pages.size();
  const auto size_ok = [page_count](const auto& values) {
    return values.empty() || values.size() == page_count;
  };

  if (!size_ok(column_index.min_values)) {
    result.malformed_reason = "min_values length does not match null_pages";
  } else if (!size_ok(column_index.max_values)) {
    result.malformed_reason = "max_values length does not match null_pages";
  } else if (!size_ok(column_index.null_counts)) {
    result.malformed_reason = "null_counts length does not match null_pages";
  } else if (!size_ok(column_index.min_values_exact)) {
    result.malformed_reason =
        "min_values_exact length does not match null_pages";
  } else if (!size_ok(column_index.max_values_exact)) {
    result.malformed_reason =
        "max_values_exact length does not match null_pages";
  }

  result.pages.resize(page_count);
  for (std::size_t i = 0; i < page_count; ++i) {
    PageStatistics& page = result.pages[i];
    page.null_page = column_index.null_pages[i];
    if (i < column_index.min_values.size()) {
      page.min_value = column_index.min_values[i];
    }
    if (i < column_index.max_values.size()) {
      page.max_value = column_index.max_values[i];
    }
    if (i < column_index.null_counts.size()) {
      page.null_count = column_index.null_counts[i];
    }
    if (i < column_index.min_values_exact.size()) {
      page.min_exact = column_index.min_values_exact[i];
    } else if (page.min_value.has_value() && page.min_value->isBinary()) {
      // Parquet does not persist a truncation bit.  Binary min/max values may
      // have been abbreviated by the writer, so do not use them as exact for
      // equality-style deductions unless the adapter explicitly says so.
      page.min_exact = false;
    }
    if (i < column_index.max_values_exact.size()) {
      page.max_exact = column_index.max_values_exact[i];
    } else if (page.max_value.has_value() && page.max_value->isBinary()) {
      page.max_exact = false;
    }
  }
  return result;
}

namespace {

std::optional<IndexValidation> validationError(std::string_view column,
                                               std::string message) {
  IndexValidation error;
  error.column = std::string(column);
  error.message = std::move(message);
  return error;
}

bool isBoundaryOrderValid(BoundaryOrder order) {
  const auto raw = static_cast<int>(order);
  return raw >= 0 && raw <= 2;
}

bool boundsComparable(const PageStatistics& page) {
  return page.min_value.has_value() && page.max_value.has_value() &&
         page.min_value->compare(*page.max_value) !=
             std::partial_ordering::unordered;
}

}  // namespace

std::optional<IndexValidation> validateColumnIndex(
    const ColumnPageIndex& column_index, std::int64_t num_rows,
    std::string_view column_name) {
  if (!column_index.malformed_reason.empty()) {
    return validationError(column_name, column_index.malformed_reason);
  }
  if (num_rows < 0) {
    return validationError(column_name, "row group has a negative row count");
  }
  if (column_index.max_repetition_level < 0 ||
      column_index.max_definition_level < 0) {
    return validationError(column_name, "negative repetition/definition level");
  }
  if (!isBoundaryOrderValid(column_index.boundary_order)) {
    return validationError(column_name, "invalid boundary order");
  }

  const std::size_t page_count = column_index.pages.size();
  const std::size_t location_count = column_index.page_locations.size();

  if (page_count == 0 && location_count != 0) {
    return validationError(column_name,
                           "offset index has locations but column index is empty");
  }
  if (location_count != 0 && location_count != page_count) {
    return validationError(column_name,
                           "offset index page count does not match column index");
  }

  if (location_count != 0) {
    std::optional<std::int64_t> previous_row;
    for (std::size_t i = 0; i < location_count; ++i) {
      const PageLocation& location = column_index.page_locations[i];
      if (location.offset < 0) {
        return validationError(column_name, "negative page offset");
      }
      if (location.compressed_page_size < 0) {
        return validationError(column_name, "negative compressed page size");
      }
      if (location.first_row_index < 0 ||
          location.first_row_index > num_rows) {
        return validationError(column_name,
                               "page first_row_index is outside the row group");
      }
      if (previous_row.has_value() &&
          location.first_row_index < *previous_row) {
        return validationError(
            column_name, "page first_row_index values are not monotonic");
      }
      if (i > 0 && column_index.max_repetition_level > 0 &&
          previous_row.has_value() &&
          location.first_row_index == *previous_row &&
          location.first_repetition_level.has_value() &&
          *location.first_repetition_level == 0) {
        return validationError(
            column_name,
            "two repeated pages share a row but the second starts a record");
      }
      previous_row = location.first_row_index;

      if (location.first_repetition_level.has_value()) {
        const std::int32_t rep = *location.first_repetition_level;
        if (rep < 0 || rep > column_index.max_repetition_level) {
          return validationError(column_name,
                                 "page repetition level is out of range");
        }
        if (i == 0 && rep != 0) {
          return validationError(
              column_name, "first page does not start at a record boundary");
        }
      } else if (i == 0 && column_index.max_repetition_level > 0) {
        // Unknown is legal; the pruner treats it conservatively.
      }
    }
    if (num_rows > 0 && column_index.page_locations.front().first_row_index !=
                            0) {
      return validationError(
          column_name, "first page does not start at row group row zero");
    }

    if (column_index.max_repetition_level == 0) {
      for (std::size_t i = 1; i < location_count; ++i) {
        if (column_index.page_locations[i].first_row_index ==
            column_index.page_locations[i - 1].first_row_index) {
          return validationError(
              column_name,
              "non-repeated column has two pages starting at the same row");
        }
      }
      for (std::size_t i = 0; i < location_count; ++i) {
        const std::int64_t begin =
            column_index.page_locations[i].first_row_index;
        const std::int64_t end =
            i + 1 < location_count
                ? column_index.page_locations[i + 1].first_row_index
                : num_rows;
        const std::int64_t page_rows = std::max<std::int64_t>(0, end - begin);
        if (column_index.pages[i].null_count.has_value() &&
            *column_index.pages[i].null_count > page_rows) {
          return validationError(
              column_name, "null count exceeds the page's row count");
        }
      }
    }
  }

  for (const PageStatistics& page : column_index.pages) {
    if (page.null_count.has_value() && *page.null_count < 0) {
      return validationError(column_name, "negative null count");
    }
    if (page.min_value.has_value() && page.max_value.has_value()) {
      const std::partial_ordering cmp =
          page.min_value->compare(*page.max_value);
      if (cmp == std::partial_ordering::unordered) {
        if (!isNaNScalar(*page.min_value) && !isNaNScalar(*page.max_value)) {
          return validationError(
              column_name, "page min and max values have incompatible types");
        }
      } else if (cmp == std::partial_ordering::greater) {
        return validationError(column_name, "page min is greater than max");
      }
    }
  }

  if (column_index.boundary_order != BoundaryOrder::Unordered) {
    const PageStatistics* previous = nullptr;
    for (const PageStatistics& page : column_index.pages) {
      if (page.null_page || !boundsComparable(page) ||
          isNaNScalar(*page.min_value) || isNaNScalar(*page.max_value)) {
        continue;
      }
      if (previous != nullptr) {
        const std::partial_ordering min_cmp =
            previous->min_value->compare(*page.min_value);
        const std::partial_ordering max_cmp =
            previous->max_value->compare(*page.max_value);
        if (min_cmp == std::partial_ordering::unordered ||
            max_cmp == std::partial_ordering::unordered) {
          return validationError(
              column_name, "boundary-ordered pages have incomparable bounds");
        }
        const bool ascending =
            column_index.boundary_order == BoundaryOrder::Ascending;
        if (ascending &&
            (min_cmp == std::partial_ordering::greater ||
             max_cmp == std::partial_ordering::greater)) {
          return validationError(
              column_name,
              "boundary order is ascending but page bounds decrease");
        }
        if (!ascending &&
            (min_cmp == std::partial_ordering::less ||
             max_cmp == std::partial_ordering::less)) {
          return validationError(
              column_name,
              "boundary order is descending but page bounds increase");
        }
      }
      previous = &page;
    }
  }

  return std::nullopt;
}

std::optional<IndexValidation> validateRowGroupIndex(
    const RowGroupIndex& row_group) {
  if (row_group.num_rows < 0) {
    return validationError({}, "row group has a negative row count");
  }
  for (const auto& [name, column] : row_group.columns) {
    if (auto error = validateColumnIndex(column, row_group.num_rows, name)) {
      return error;
    }
  }
  return std::nullopt;
}

bool PageSelection::isCandidate(std::int32_t page) const {
  if (page < 0 || static_cast<std::size_t>(page) >= candidate.size()) {
    return false;
  }
  return candidate[static_cast<std::size_t>(page)] != 0;
}

bool PruneResult::containsRow(std::int64_t row) const {
  std::size_t low = 0;
  std::size_t high = candidate_rows.size();
  while (low < high) {
    const std::size_t mid = low + (high - low) / 2;
    if (candidate_rows[mid].end <= row) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low < candidate_rows.size() && candidate_rows[low].contains(row);
}

std::int64_t PruneResult::candidateRowCount() const {
  std::int64_t total = 0;
  for (const RowRange& range : candidate_rows) {
    total += range.size();
  }
  return total;
}

const PageSelection* PruneResult::pageSelection(
    std::string_view column) const {
  const auto it = page_selections.find(column);
  return it == page_selections.end() ? nullptr : &it->second;
}

bool PruneResult::isPageCandidate(std::string_view column,
                                  std::int32_t page) const {
  const PageSelection* selection = pageSelection(column);
  return selection != nullptr && selection->isCandidate(page);
}

namespace {

struct PageSpan {
  std::int64_t begin = 0;
  std::int64_t end = 0;
};

std::int64_t clampRow(std::int64_t row, std::int64_t num_rows) {
  if (row < 0) {
    return 0;
  }
  if (row > num_rows) {
    return num_rows;
  }
  return row;
}

bool pageStartsInsideRecord(const ColumnPageIndex& column,
                            const PageLocation& location) {
  if (column.max_repetition_level <= 0) {
    return false;
  }
  if (location.first_repetition_level.has_value()) {
    return *location.first_repetition_level > 0;
  }
  // The first repetition level is not available.  For a repeated column a
  // page boundary may split a record, so share the boundary row.
  return true;
}

std::vector<PageSpan> computePageSpans(const ColumnPageIndex& column,
                                       std::int64_t num_rows) {
  std::vector<PageSpan> spans;
  if (column.pages.empty() || column.page_locations.empty()) {
    return spans;
  }
  if (column.page_locations.size() != column.pages.size()) {
    return spans;
  }

  const std::size_t count = column.pages.size();
  spans.resize(count);
  for (std::size_t i = 0; i < count; ++i) {
    const std::int64_t begin =
        clampRow(column.page_locations[i].first_row_index, num_rows);
    std::int64_t end = num_rows;
    if (i + 1 < count) {
      end = clampRow(column.page_locations[i + 1].first_row_index, num_rows);
      // A duplicate first_row_index means both pages may contain the same
      // record even if the next page's repetition level is unavailable or
      // inconsistent.  Share the row conservatively.
      const bool duplicate_boundary = end == begin;
      if ((duplicate_boundary ||
           pageStartsInsideRecord(column, column.page_locations[i + 1])) &&
          end < num_rows) {
        end += 1;
      }
    }
    if (end < begin) {
      end = begin;
    }
    spans[i] = PageSpan{begin, end};
  }
  return spans;
}

enum class Truth : std::uint8_t {
  False,
  Unknown,
  True,
};

struct Eval {
  Truth truth = Truth::Unknown;
  bool may_match = true;
  bool may_fail = true;
  bool insufficient = false;
};

Truth negateTruth(Truth truth) {
  switch (truth) {
    case Truth::True:
      return Truth::False;
    case Truth::False:
      return Truth::True;
    case Truth::Unknown:
      return Truth::Unknown;
  }
  return Truth::Unknown;
}

Eval constantEval(bool value) {
  if (value) {
    return Eval{Truth::True, true, false, false};
  }
  return Eval{Truth::False, false, true, false};
}

Eval unknownEval(bool insufficient) {
  return Eval{Truth::Unknown, true, true, insufficient};
}

struct RangeEval {
  bool available = false;
  bool all_true = false;
  bool all_false = false;
};

RangeEval evaluateRange(const PageStatistics& page, CompareOp op,
                        const Value& constant) {
  if (!page.min_value.has_value() || !page.max_value.has_value()) {
    return {};
  }

  const std::partial_ordering to_min = constant.compare(*page.min_value);
  const std::partial_ordering to_max = constant.compare(*page.max_value);
  if (to_min == std::partial_ordering::unordered ||
      to_max == std::partial_ordering::unordered) {
    return {};
  }

  RangeEval result;
  result.available = true;
  const bool exact_equality =
      page.min_exact && page.max_exact &&
      to_min == std::partial_ordering::equivalent &&
      to_max == std::partial_ordering::equivalent;

  switch (op) {
    case CompareOp::Eq:
      if (to_min == std::partial_ordering::less ||
          to_max == std::partial_ordering::greater) {
        result.all_false = true;
      } else if (exact_equality) {
        result.all_true = true;
      }
      break;
    case CompareOp::NotEq:
      if (to_min == std::partial_ordering::less ||
          to_max == std::partial_ordering::greater) {
        result.all_true = true;
      } else if (exact_equality) {
        result.all_false = true;
      }
      break;
    case CompareOp::Lt:
      if (to_max == std::partial_ordering::greater) {
        result.all_true = true;
      } else if (to_min != std::partial_ordering::greater) {
        result.all_false = true;
      }
      break;
    case CompareOp::Le:
      if (to_max != std::partial_ordering::less) {
        result.all_true = true;
      } else if (to_min == std::partial_ordering::less) {
        result.all_false = true;
      }
      break;
    case CompareOp::Gt:
      if (to_min == std::partial_ordering::less) {
        result.all_true = true;
      } else if (to_max != std::partial_ordering::less) {
        result.all_false = true;
      }
      break;
    case CompareOp::Ge:
      if (to_min != std::partial_ordering::greater) {
        result.all_true = true;
      } else if (to_max == std::partial_ordering::greater) {
        result.all_false = true;
      }
      break;
  }
  return result;
}

bool pageAllNull(const PageStatistics& page, std::int64_t rows,
                 bool repeated) {
  if (page.null_page) {
    return true;
  }
  if (!repeated && rows > 0 && page.null_count.has_value() &&
      *page.null_count >= rows) {
    return true;
  }
  return false;
}

Eval evaluateComparisonPage(const PageStatistics& page, std::int64_t rows,
                            bool repeated, CompareOp op,
                            const Value& constant) {
  if (pageAllNull(page, rows, repeated)) {
    // Null values never select a comparison predicate.  SQL truth is UNKNOWN,
    // but there is provably no matching row in the page.
    return Eval{Truth::Unknown, false, false, false};
  }

  const bool no_nulls =
      page.null_count.has_value() && *page.null_count == 0;
  const RangeEval range = evaluateRange(page, op, constant);
  if (!range.available) {
    return unknownEval(true);
  }

  Eval result;
  result.insufficient = false;
  if (range.all_false) {
    result.truth = no_nulls ? Truth::False : Truth::Unknown;
    result.may_match = false;
    result.may_fail = true;
  } else if (range.all_true) {
    result.truth = no_nulls ? Truth::True : Truth::Unknown;
    result.may_match = true;
    result.may_fail = false;
  } else {
    result.truth = Truth::Unknown;
    result.may_match = true;
    result.may_fail = true;
  }

  if (repeated) {
    // A page can contain rows with an empty repeated field.  Those rows have
    // no matching value even when every stored value matches; therefore a
    // page-level TRUE is not a row-level TRUE.
    if (result.truth == Truth::True) {
      result.truth = Truth::Unknown;
    }
    if (rows > 0) {
      result.may_fail = true;
    }
  }
  return result;
}

Eval evaluateNullPage(const PageStatistics& page, std::int64_t rows,
                      bool repeated, bool want_null) {
  const bool all_null = pageAllNull(page, rows, repeated);
  const bool no_nulls =
      page.null_count.has_value() && *page.null_count == 0;
  const bool counts_unknown = !page.null_count.has_value();

  if (all_null) {
    if (want_null) {
      Eval result{repeated ? Truth::Unknown : Truth::True, true,
                  repeated, false};
      return result;
    }
    return Eval{Truth::False, false, true, false};
  }

  if (no_nulls) {
    if (want_null) {
      return Eval{Truth::False, false, true, false};
    }
    Eval result{repeated ? Truth::Unknown : Truth::True, true,
                repeated, false};
    return result;
  }

  // Some nulls, or the count is absent.  A null count of zero was handled
  // above, so this page may contain both null and non-null rows.
  return unknownEval(counts_unknown);
}

Eval evaluatePage(const PageStatistics& page, std::int64_t rows,
                  bool repeated, const Predicate& predicate) {
  switch (predicate.kind()) {
    case Predicate::Kind::Compare:
      return evaluateComparisonPage(page, rows, repeated,
                                    predicate.compareOp(), predicate.value());
    case Predicate::Kind::IsNull:
      return evaluateNullPage(page, rows, repeated, true);
    case Predicate::Kind::IsNotNull:
      return evaluateNullPage(page, rows, repeated, false);
    default:
      return unknownEval(true);
  }
}

struct LeafInfo {
  const ColumnPageIndex* column = nullptr;
  std::vector<PageSpan> spans;
  bool mapped = false;
};

struct EvalContext {
  std::map<std::string, LeafInfo, std::less<>> leaves;
  bool allow_repeated_pruning = true;
};

Eval combineOverlappingPages(const std::vector<Eval>& pages,
                             bool repeated) {
  if (pages.empty()) {
    return unknownEval(true);
  }
  if (pages.size() == 1) {
    return pages.front();
  }

  bool may_match = false;
  bool may_fail = false;
  bool all_false = true;
  bool insufficient = false;
  for (const Eval& page : pages) {
    may_match = may_match || page.may_match;
    may_fail = may_fail || page.may_fail;
    all_false = all_false && page.truth == Truth::False;
    insufficient = insufficient || page.insufficient;
  }

  Eval result;
  result.truth = all_false ? Truth::False : Truth::Unknown;
  result.may_match = may_match;
  // With repeated fields a record can span pages; the conservative answer for
  // negation is that a failing value may exist.
  result.may_fail = repeated ? true : may_fail;
  result.insufficient = insufficient;
  return result;
}

Eval evaluateLeaf(const Predicate& predicate, std::int64_t begin,
                  std::int64_t end, EvalContext& context) {
  const auto it = context.leaves.find(predicate.column());
  if (it == context.leaves.end()) {
    return unknownEval(true);
  }
  const LeafInfo& leaf = it->second;
  if (leaf.column == nullptr || !leaf.mapped || leaf.column->pages.empty()) {
    return unknownEval(true);
  }
  if (leaf.column->isRepeated() && !context.allow_repeated_pruning) {
    return unknownEval(true);
  }

  std::vector<Eval> overlapping;
  const auto first = std::upper_bound(
      leaf.spans.begin(), leaf.spans.end(), begin,
      [](std::int64_t value, const PageSpan& span) { return value < span.end; });
  for (auto it = first; it != leaf.spans.end() && it->begin < end; ++it) {
    const std::size_t i = static_cast<std::size_t>(it - leaf.spans.begin());
    const std::int64_t rows =
        std::max<std::int64_t>(0, it->end - it->begin);
    overlapping.push_back(evaluatePage(leaf.column->pages[i], rows,
                                       leaf.column->isRepeated(), predicate));
  }
  if (overlapping.empty()) {
    // Rows not covered by the offset index cannot be evaluated safely.
    return unknownEval(true);
  }
  return combineOverlappingPages(overlapping, leaf.column->isRepeated());
}

Eval evaluatePredicate(const Predicate& predicate, std::int64_t begin,
                       std::int64_t end, EvalContext& context) {
  switch (predicate.kind()) {
    case Predicate::Kind::True:
      return constantEval(true);
    case Predicate::Kind::False:
      return constantEval(false);
    case Predicate::Kind::Compare:
    case Predicate::Kind::IsNull:
    case Predicate::Kind::IsNotNull:
      return evaluateLeaf(predicate, begin, end, context);
    case Predicate::Kind::And: {
      const auto& children = predicate.children();
      if (children.empty()) {
        return constantEval(true);
      }
      Eval result = constantEval(true);
      for (const Predicate& child : children) {
        const Eval current = evaluatePredicate(child, begin, end, context);
        result.may_match = result.may_match && current.may_match;
        result.may_fail = result.may_fail || current.may_fail;
        result.insufficient = result.insufficient || current.insufficient;
        if (current.truth == Truth::False) {
          result.truth = Truth::False;
        } else if (current.truth == Truth::Unknown &&
                   result.truth != Truth::False) {
          result.truth = Truth::Unknown;
        }
      }
      return result;
    }
    case Predicate::Kind::Or: {
      const auto& children = predicate.children();
      if (children.empty()) {
        return constantEval(false);
      }
      Eval result = constantEval(false);
      for (const Predicate& child : children) {
        const Eval current = evaluatePredicate(child, begin, end, context);
        result.may_match = result.may_match || current.may_match;
        result.may_fail = result.may_fail && current.may_fail;
        result.insufficient = result.insufficient || current.insufficient;
        if (current.truth == Truth::True) {
          result.truth = Truth::True;
        } else if (current.truth == Truth::Unknown &&
                   result.truth != Truth::True) {
          result.truth = Truth::Unknown;
        }
      }
      return result;
    }
    case Predicate::Kind::Not: {
      const auto& children = predicate.children();
      if (children.empty()) {
        return unknownEval(true);
      }
      const Eval child =
          evaluatePredicate(children.front(), begin, end, context);
      return Eval{negateTruth(child.truth), child.may_fail, child.may_match,
                  child.insufficient};
    }
  }
  return unknownEval(true);
}

void mergeRowRange(std::vector<RowRange>& ranges, std::int64_t begin,
                   std::int64_t end) {
  if (end <= begin) {
    return;
  }
  if (!ranges.empty() && ranges.back().end == begin) {
    ranges.back().end = end;
    return;
  }
  ranges.push_back(RowRange{begin, end});
}

PageSelection buildPageSelection(const ColumnPageIndex& column,
                                 const std::vector<RowRange>& rows,
                                 bool fallback) {
  PageSelection selection;
  selection.candidate.assign(column.pages.size(), 0);
  if (column.pages.empty()) {
    return selection;
  }

  if (fallback) {
    std::fill(selection.candidate.begin(), selection.candidate.end(), 1);
  } else if (!rows.empty()) {
    if (column.page_locations.empty() ||
        column.page_locations.size() != column.pages.size()) {
      // Without an offset index the rows cannot be mapped to pages.
      std::fill(selection.candidate.begin(), selection.candidate.end(), 1);
    } else {
      const std::vector<PageSpan> spans =
          computePageSpans(column, rows.back().end);
      for (std::size_t i = 0; i < spans.size(); ++i) {
        const auto first = std::upper_bound(
            rows.begin(), rows.end(), spans[i].begin,
            [](std::int64_t value, const RowRange& range) {
              return value < range.end;
            });
        if (first != rows.end() && first->begin < spans[i].end) {
          selection.candidate[i] = 1;
        }
      }
    }
  }

  bool all = true;
  for (std::size_t i = 0; i < selection.candidate.size(); ++i) {
    if (selection.candidate[i] != 0) {
      selection.pages.push_back(static_cast<std::int32_t>(i));
    } else {
      all = false;
    }
  }
  selection.all = all;
  return selection;
}

PruneResult fallbackResult(const RowGroupIndex& row_group,
                           std::string detail) {
  PruneResult result;
  result.status = PruneStatus::CorruptIndex;
  result.fallback = true;
  result.has_unknown = true;
  result.num_rows = std::max<std::int64_t>(0, row_group.num_rows);
  result.detail = std::move(detail);
  if (result.num_rows > 0) {
    result.candidate_rows.push_back(RowRange{0, result.num_rows});
  }
  for (const auto& [name, column] : row_group.columns) {
    result.page_selections.emplace(
        name, buildPageSelection(column, result.candidate_rows, true));
  }
  return result;
}

}  // namespace

PruneResult prune(const RowGroupIndex& row_group, const Predicate& predicate,
                  const PruneOptions& options) {
  if (row_group.num_rows < 0) {
    return fallbackResult(row_group, "row group has a negative row count");
  }

  if (options.validate_all_columns) {
    if (auto error = validateRowGroupIndex(row_group)) {
      std::ostringstream message;
      if (!error->column.empty()) {
        message << error->column << ": ";
      }
      message << error->message;
      return fallbackResult(row_group, message.str());
    }
  } else {
    for (const std::string& column_name : predicate.referencedColumns()) {
      const ColumnPageIndex* column = row_group.find(column_name);
      if (column == nullptr) {
        continue;
      }
      if (auto error =
              validateColumnIndex(*column, row_group.num_rows, column_name)) {
        std::ostringstream message;
        message << error->column << ": " << error->message;
        return fallbackResult(row_group, message.str());
      }
    }
  }

  if (row_group.num_rows == 0) {
    PruneResult result;
    result.num_rows = 0;
    for (const auto& [name, column] : row_group.columns) {
      result.page_selections.emplace(
          name, buildPageSelection(column, result.candidate_rows, false));
    }
    return result;
  }

  EvalContext context;
  context.allow_repeated_pruning = options.allow_repeated_pruning;

  std::set<std::int64_t> boundaries{0, row_group.num_rows};
  for (const std::string& column_name : predicate.referencedColumns()) {
    const ColumnPageIndex* column = row_group.find(column_name);
    LeafInfo leaf;
    leaf.column = column;
    if (column != nullptr && !column->pages.empty() &&
        !column->page_locations.empty() &&
        column->page_locations.size() == column->pages.size() &&
        (options.allow_repeated_pruning || !column->isRepeated())) {
      leaf.spans = computePageSpans(*column, row_group.num_rows);
      leaf.mapped = !leaf.spans.empty();
      for (const PageSpan& span : leaf.spans) {
        boundaries.insert(span.begin);
        boundaries.insert(span.end);
      }
    }
    context.leaves.emplace(column_name, std::move(leaf));
  }

  PruneResult result;
  result.num_rows = row_group.num_rows;
  std::vector<std::int64_t> ordered_boundaries(boundaries.begin(),
                                               boundaries.end());
  for (std::size_t i = 0; i + 1 < ordered_boundaries.size(); ++i) {
    const std::int64_t begin = ordered_boundaries[i];
    const std::int64_t end = ordered_boundaries[i + 1];
    if (begin >= end) {
      continue;
    }
    const Eval eval = evaluatePredicate(predicate, begin, end, context);
    if (eval.may_match) {
      mergeRowRange(result.candidate_rows, begin, end);
      if (eval.insufficient) {
        result.has_unknown = true;
      }
    }
  }

  for (const auto& [name, column] : row_group.columns) {
    result.page_selections.emplace(
        name, buildPageSelection(column, result.candidate_rows, false));
  }
  return result;
}

PageIndexPruner::PageIndexPruner(RowGroupIndex row_group,
                                 PruneOptions options)
    : row_group_(std::move(row_group)), options_(options) {}

PruneResult PageIndexPruner::prune(const Predicate& predicate) const {
  return dataeng::prune(row_group_, predicate, options_);
}

}  // namespace dataeng
