#pragma once

#include <array>
#include <compare>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

// A small, dependency-free Parquet page-index pruning component.
//
// The component works on decoded page metadata: the column index (min/max,
// null pages, null counts, boundary order) and the offset index (page row
// starts).  It never inspects page data and it never decodes compressed
// buffers, which makes it easy to embed in a columnar scanner.
//
// Correctness contract:
//   * A row/page is excluded only when the available metadata proves that no
//     row in it can satisfy the predicate.
//   * Missing statistics produce UNKNOWN, not FALSE.
//   * Truncated binary bounds are used only as a lower bound (min) or an upper
//     bound (max).  Equality-style proofs require exact bounds.
//   * A structurally corrupt page index causes the whole row group to be
//     returned as a candidate.

namespace dataeng {

enum class BoundaryOrder : std::int8_t {
  Unordered = 0,
  Ascending = 1,
  Descending = 2,
};

enum class PhysicalType : std::uint8_t {
  Boolean,
  Int32,
  Int64,
  Int96,
  Float,
  Double,
  ByteArray,
  FixedLenByteArray,
};

// A decoded Parquet statistics value.  Byte arrays are compared as unsigned
// byte strings, which is the ordering Parquet uses for binary and INT96
// columns.  Numeric comparisons only permit compatible numeric kinds
// (Int32/Int64 and Float/Double); an incompatible comparison is unordered.
class Value {
 public:
  enum class Kind : std::uint8_t {
    Null,
    Boolean,
    Int32,
    Int64,
    Float,
    Double,
    String,
    Binary,
    FixedLenByteArray,
    Int96,
  };

  using Bytes = std::vector<std::uint8_t>;
  using Int96Bytes = std::array<std::uint8_t, 12>;

  Value() = default;

  static Value boolean(bool value);
  static Value int32(std::int32_t value);
  static Value int64(std::int64_t value);
  static Value float32(float value);
  static Value float64(double value);
  static Value string(std::string value);
  static Value binary(Bytes value);
  static Value fixedLenByteArray(Bytes value);
  static Value int96(Int96Bytes value);

  Kind kind() const { return kind_; }
  PhysicalType physicalType() const;
  bool isNull() const { return kind() == Kind::Null; }
  bool isBinary() const;
  bool isNumeric() const;

  // std::partial_ordering::unordered is returned for NaNs and for values of
  // incompatible types.
  std::partial_ordering compare(const Value& other) const;

  friend std::partial_ordering operator<=>(const Value& lhs, const Value& rhs) {
    return lhs.compare(rhs);
  }
  friend bool operator==(const Value& lhs, const Value& rhs) {
    return lhs.compare(rhs) == std::partial_ordering::equivalent;
  }

  const std::variant<std::monostate, bool, std::int32_t, std::int64_t, float,
                     double, std::string, Bytes, Int96Bytes>&
  storage() const {
    return storage_;
  }

 private:
  using Storage =
      std::variant<std::monostate, bool, std::int32_t, std::int64_t, float,
                   double, std::string, Bytes, Int96Bytes>;

  Value(Kind kind, Storage storage)
      : kind_(kind), storage_(std::move(storage)) {}

  Kind kind_ = Kind::Null;
  Storage storage_;
};

// One offset-index entry.  first_repetition_level is the repetition level of
// the first value in the page.  It is optional because Parquet's offset index
// does not store it; a scanner that has decoded the first page value can
// provide it.  For a repeated column, a non-zero value means this page starts
// in the middle of the record identified by first_row_index.
struct PageLocation {
  std::int64_t offset = 0;
  std::int32_t compressed_page_size = 0;
  std::int64_t first_row_index = 0;
  std::optional<std::int32_t> first_repetition_level;
};

struct PageStatistics {
  // True if every value in the page is null.  Such a page normally has no
  // min/max values.
  bool null_page = false;

  // min_value is a lower bound and max_value is an upper bound for all
  // non-null values in the page.  Missing bounds mean "unknown".
  std::optional<Value> min_value;
  std::optional<Value> max_value;

  // Parquet's ColumnIndex null_counts entry.  For a flat column this is the
  // number of null rows in the page; for a repeated column it counts null leaf
  // values and therefore must not be compared with the page's row count.
  std::optional<std::int64_t> null_count;

  // False when the writer truncated or widened the bound.  Truncated bounds
  // are still safe in their bound direction, but equality-style deductions
  // (min == max == constant) require both flags to be true.
  bool min_exact = true;
  bool max_exact = true;
};

// Decoded Parquet ColumnIndex.  min_values/max_values and the exactness arrays
// may be empty to mean "statistics absent"; otherwise their size must equal
// null_pages.size().
struct ParquetColumnIndex {
  std::vector<bool> null_pages;
  std::vector<std::optional<Value>> min_values;
  std::vector<std::optional<Value>> max_values;
  BoundaryOrder boundary_order = BoundaryOrder::Unordered;
  std::vector<std::optional<std::int64_t>> null_counts;
  std::vector<bool> min_values_exact;
  std::vector<bool> max_values_exact;
};

// Decoded Parquet OffsetIndex.
struct ParquetOffsetIndex {
  std::vector<PageLocation> page_locations;
};

using ColumnIndex = ParquetColumnIndex;
using OffsetIndex = ParquetOffsetIndex;

// The joined view used by the pruner.  pages[i] corresponds to
// page_locations[i].
struct ColumnPageIndex {
  std::vector<PageStatistics> pages;
  std::vector<PageLocation> page_locations;
  BoundaryOrder boundary_order = BoundaryOrder::Unordered;
  std::int32_t max_repetition_level = 0;
  std::int32_t max_definition_level = 0;

  // Adapters set this when the source arrays are structurally inconsistent
  // (for example, min_values has a different length than null_pages).
  std::string malformed_reason;

  bool isRepeated() const { return max_repetition_level > 0; }

  static ColumnPageIndex from(const ParquetColumnIndex& column_index,
                              const ParquetOffsetIndex& offset_index,
                              std::int32_t max_repetition_level = 0,
                              std::int32_t max_definition_level = 0);
};

struct RowGroupIndex {
  std::int64_t num_rows = 0;
  std::map<std::string, ColumnPageIndex, std::less<>> columns;

  const ColumnPageIndex* find(std::string_view column) const;
};

enum class CompareOp : std::uint8_t { Eq, NotEq, Lt, Le, Gt, Ge };

// A predicate tree.  Comparisons and null tests are leaves; all()/any()/negate()
// build three-valued combinations.
class Predicate {
 public:
  enum class Kind : std::uint8_t {
    True,
    False,
    Compare,
    IsNull,
    IsNotNull,
    And,
    Or,
    Not,
  };

  Predicate();  // constant TRUE

  static Predicate constant(bool value);
  static Predicate compare(std::string column, CompareOp op, Value value);
  static Predicate isNull(std::string column);
  static Predicate isNotNull(std::string column);
  static Predicate all(std::vector<Predicate> predicates);  // AND
  static Predicate any(std::vector<Predicate> predicates);  // OR
  static Predicate negate(Predicate predicate);

  static Predicate eq(std::string column, Value value);
  static Predicate ne(std::string column, Value value);
  static Predicate lt(std::string column, Value value);
  static Predicate le(std::string column, Value value);
  static Predicate gt(std::string column, Value value);
  static Predicate ge(std::string column, Value value);

  Kind kind() const;
  bool isConstant() const;
  const std::string& column() const;
  CompareOp compareOp() const;
  const Value& value() const;
  const std::vector<Predicate>& children() const;

  // Stable, de-duplicated list of columns referenced by leaf predicates.
  std::vector<std::string> referencedColumns() const;

 private:
  struct Node;
  explicit Predicate(std::shared_ptr<const Node> node) : node_(std::move(node)) {}

  std::shared_ptr<const Node> node_;
};

Predicate operator&&(Predicate lhs, Predicate rhs);
Predicate operator||(Predicate lhs, Predicate rhs);
Predicate operator!(Predicate predicate);

struct IndexValidation {
  std::string column;
  std::string message;
};

// Returns std::nullopt when the column index is structurally usable.  A
// missing offset index is not corruption: it only prevents row mapping and is
// reported as UNKNOWN during pruning.
std::optional<IndexValidation> validateColumnIndex(
    const ColumnPageIndex& column_index, std::int64_t num_rows,
    std::string_view column_name = {});

std::optional<IndexValidation> validateRowGroupIndex(
    const RowGroupIndex& row_group);

struct PruneOptions {
  // Validate every supplied column, not just columns referenced by the
  // predicate.  A corrupt index then falls back to the whole row group.
  bool validate_all_columns = true;

  // Set false to treat repeated columns as UNKNOWN (conservative).  The default
  // uses repetition-level information and page row spans.
  bool allow_repeated_pruning = true;
};

enum class PruneStatus : std::uint8_t {
  Ok,
  CorruptIndex,
};

struct RowRange {
  std::int64_t begin = 0;
  std::int64_t end = 0;

  std::int64_t size() const { return end > begin ? end - begin : 0; }
  bool empty() const { return end <= begin; }
  bool contains(std::int64_t row) const { return row >= begin && row < end; }
};

struct PageSelection {
  // candidate[i] is non-zero when page i must be read.
  std::vector<std::uint8_t> candidate;
  std::vector<std::int32_t> pages;
  bool all = false;

  bool isCandidate(std::int32_t page) const;
};

struct PruneResult {
  PruneStatus status = PruneStatus::Ok;
  bool fallback = false;
  bool has_unknown = false;
  std::int64_t num_rows = 0;
  std::string detail;
  std::vector<RowRange> candidate_rows;
  std::map<std::string, PageSelection, std::less<>> page_selections;

  bool containsRow(std::int64_t row) const;
  std::int64_t candidateRowCount() const;
  const PageSelection* pageSelection(std::string_view column) const;
  bool isPageCandidate(std::string_view column, std::int32_t page) const;
};

PruneResult prune(const RowGroupIndex& row_group, const Predicate& predicate,
                  const PruneOptions& options = {});

class PageIndexPruner {
 public:
  explicit PageIndexPruner(RowGroupIndex row_group,
                           PruneOptions options = {});

  PruneResult prune(const Predicate& predicate) const;

  const RowGroupIndex& rowGroup() const { return row_group_; }

 private:
  RowGroupIndex row_group_;
  PruneOptions options_;
};

}  // namespace dataeng
