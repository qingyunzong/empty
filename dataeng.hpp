#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

// A small, dependency-free Parquet page-index pruning component.
//
// The API intentionally mirrors the thrift structures used by Parquet:
//   * ColumnIndex:  null_pages, min_values, max_values, boundary_order,
//                   null_counts, is_min_value_exact, is_max_value_exact.
//   * OffsetIndex:  page_locations, each with first_row_index.
//
// The pruner is conservative.  It may return a page that cannot match, but it
// never rejects a page that can contain a matching row.  In particular:
//   * NaN in the statistics disables min/max pruning for that page.
//   * A literal NaN is handled according to IEEE comparison rules.
//   * Truncated byte-array maxima are treated as prefix bounds (see below).
//   * SortOrder::Unknown disables all min/max based pruning.
//   * Repeated/nested pages are mapped to rows using first_row_index; pages
//     starting in the same row are merged so a candidate page always covers
//     its starting row.

namespace dataeng {

enum class PhysicalType : std::uint8_t {
  Boolean = 0,
  Int32,
  Int64,
  Int96,
  Float,
  Double,
  ByteArray,
  FixedLenByteArray,

  // Upper-case aliases make the enum convenient when translating thrift data.
  BOOLEAN = Boolean,
  INT32 = Int32,
  INT64 = Int64,
  INT96 = Int96,
  FLOAT = Float,
  DOUBLE = Double,
  BYTE_ARRAY = ByteArray,
  FIXED_LEN_BYTE_ARRAY = FixedLenByteArray,
};

// Parquet's TypeDefinedOrder.  Unknown means that the column has no ordering
// the pruner may rely on (for example, the deprecated INT96 type).
enum class SortOrder : std::uint8_t {
  Unknown = 0,
  Signed,
  Unsigned,

  UNKNOWN = Unknown,
  SIGNED = Signed,
  UNSIGNED = Unsigned,
};

enum class BoundaryOrder : std::uint8_t {
  Unordered = 0,
  Ascending,
  Descending,

  UNORDERED = Unordered,
  ASCENDING = Ascending,
  DESCENDING = Descending,
};

enum class LogicalType : std::uint8_t {
  None = 0,
  Utf8,
  Decimal,
  Date,
  Time,
  Timestamp,
  Integer,
  Json,
  Bson,
  Enum,
  Uuid,
  Interval,
  Unknown,

  NONE = None,
  UTF8 = Utf8,
  DECIMAL = Decimal,
  DATE = Date,
  TIME = Time,
  TIMESTAMP = Timestamp,
  INTEGER = Integer,
  JSON = Json,
  BSON = Bson,
  ENUM = Enum,
  UUID = Uuid,
  INTERVAL = Interval,
  UNKNOWN = Unknown,
};

enum class CompareOp : std::uint8_t {
  Equal = 0,
  NotEqual,
  Less,
  LessEqual,
  Greater,
  GreaterEqual,

  EQ = Equal,
  NE = NotEqual,
  LT = Less,
  LE = LessEqual,
  GT = Greater,
  GE = GreaterEqual,
};

// A column chunk descriptor.  physical_type is the Parquet physical type;
// sort_order is the column's TypeDefinedOrder (or Unknown).  logical_type is
// only needed to distinguish DECIMAL byte arrays from ordinary byte arrays.
struct ColumnDescriptor {
  PhysicalType physical_type = PhysicalType::ByteArray;
  SortOrder sort_order = SortOrder::Unknown;
  LogicalType logical_type = LogicalType::None;
  std::int32_t type_length = 0;  // FixedLenByteArray length, when applicable
  std::int32_t decimal_scale = 0;
  std::int32_t decimal_precision = 0;
  // Enables conservative handling of zero-leaf-value repeated pages.
  bool nested_repeated = false;
  std::string name;

  // Builds a descriptor with the natural sort order implied by the physical
  // and logical types.  For byte arrays the default is unsigned lexicographic;
  // for DECIMAL it is signed big-endian two's complement; INT96 remains
  // Unknown deliberately.
  static ColumnDescriptor make(PhysicalType type,
                               LogicalType logical = LogicalType::None);
  static ColumnDescriptor make(PhysicalType type, SortOrder order,
                               LogicalType logical = LogicalType::None);
};

SortOrder default_sort_order(PhysicalType type,
                             LogicalType logical = LogicalType::None);

enum class LiteralKind : std::uint8_t {
  Boolean = 0,
  Int32,
  UInt32,
  Int64,
  UInt64,
  Float,
  Double,
  Binary,

  BOOLEAN = Boolean,
  INT32 = Int32,
  UINT32 = UInt32,
  INT64 = Int64,
  UINT64 = UInt64,
  FLOAT = Float,
  DOUBLE = Double,
  BINARY = Binary,
};

// A predicate literal.  bytes always contains the Parquet PLAIN-encoded value
// in the column's physical representation, so callers with already encoded
// values can construct a Literal directly.
struct Literal {
  LiteralKind kind = LiteralKind::Binary;
  bool bool_value = false;
  std::int64_t signed_value = 0;
  std::uint64_t unsigned_value = 0;
  double double_value = 0.0;
  std::string bytes;

  bool is_nan() const;
  std::string_view encoded() const { return bytes; }

  static Literal Boolean(bool value);
  static Literal Int32(std::int32_t value);
  static Literal UInt32(std::uint32_t value);
  static Literal Int64(std::int64_t value);
  static Literal UInt64(std::uint64_t value);
  static Literal Float(float value);
  static Literal Double(double value);
  static Literal Binary(std::string value);
  static Literal String(std::string_view value);
  static Literal Bytes(std::string_view value) {
    return Binary(std::string(value));
  }
};

// A predicate expression over one column chunk.  Expressions are deliberately
// small and copyable.  All comparison literals are compared using the column
// descriptor's physical/logical representation.
struct Expr {
  enum class Kind : std::uint8_t {
    True = 0,
    False,
    And,
    Or,
    Not,
    Compare,
    IsNull,
    IsNotNull,
    IsNaN,
    IsNotNaN,
  };

  Kind kind = Kind::True;
  CompareOp op = CompareOp::Equal;
  Literal literal;
  std::vector<Expr> children;

  static Expr always_true();
  static Expr always_false();
  static Expr compare(CompareOp op, Literal literal);
  static Expr is_null();
  static Expr is_not_null();
  static Expr is_nan();
  static Expr is_not_nan();
  static Expr all(std::vector<Expr> children);
  static Expr any(std::vector<Expr> children);
  static Expr negate(Expr child);
};

// Direct mirror of the Parquet ColumnIndex.
//
// Optional vectors may be empty, or shorter than the page count.  A missing
// entry means "unknown", not "false"; unknown statistics never prune a page.
struct ColumnIndex {
  std::vector<bool> null_pages;
  std::vector<std::string> min_values;
  std::vector<std::string> max_values;
  BoundaryOrder boundary_order = BoundaryOrder::Unordered;
  std::vector<std::int64_t> null_counts;          // -1 or missing = unknown
  std::vector<bool> is_min_value_exact;           // missing = writer default
  std::vector<bool> is_max_value_exact;           // missing = writer default

  // Optional extensions, useful for IS NULL and NaN-aware pruning.  They are
  // not part of the thrift ColumnIndex and may safely be left empty.
  std::vector<std::int64_t> num_values;           // -1 or missing = unknown
  std::vector<bool> may_contain_nan;              // missing = unknown (true)

  std::size_t page_count() const;
};

struct PageLocation {
  std::int64_t offset = 0;
  std::int64_t compressed_page_size = 0;
  std::int64_t first_row_index = 0;
};

// Direct mirror of the Parquet OffsetIndex.  num_rows is the row count of the
// column chunk and is needed to close the final page's row range.
struct OffsetIndex {
  std::vector<PageLocation> page_locations;
  std::int64_t num_rows = -1;
};

struct PruningOptions {
  // Parquet permits writers to omit is_min_value_exact/is_max_value_exact for
  // byte arrays.  Missing flags are treated as "may be truncated" by default.
  // Set this only when the writer is known not to truncate binary statistics.
  bool assume_binary_stats_exact_when_unspecified = false;

  // Merge touching row ranges as well as overlapping ones.
  bool merge_adjacent_row_ranges = true;
};

struct PageStatistics {
  bool all_null = false;
  bool has_min = false;
  bool has_max = false;
  bool min_exact = false;
  bool max_exact = false;
  bool min_nan = false;
  bool max_nan = false;
  bool has_null_count = false;
  std::int64_t null_count = 0;
  bool has_num_values = false;
  std::int64_t num_values = 0;
  bool may_contain_nan = true;
  std::string_view min_value;
  std::string_view max_value;
};

PageStatistics page_statistics(const ColumnDescriptor& descriptor,
                                const ColumnIndex& index,
                                std::size_t page,
                                const PruningOptions& options = {});

// Abstract truth values for one page.  may_true means "the page can contain a
// row for which the expression evaluates to TRUE"; may_false means "the page
// can contain a row for which it evaluates to FALSE".  SQL NULL is neither.
struct Truth {
  bool may_true = true;
  bool may_false = true;
};

Truth evaluate_page(const ColumnDescriptor& descriptor,
                    const ColumnIndex& index,
                    std::size_t page,
                    const Expr& expression,
                    const PruningOptions& options = {});

bool page_may_match(const ColumnDescriptor& descriptor,
                    const ColumnIndex& index,
                    std::size_t page,
                    const Expr& expression,
                    const PruningOptions& options = {});

struct RowRange {
  std::int64_t first_row = 0;
  std::int64_t end_row = 0;  // exclusive

  bool empty() const { return end_row <= first_row; }
  std::int64_t size() const {
    return end_row > first_row ? end_row - first_row : 0;
  }
  friend bool operator==(const RowRange&, const RowRange&) = default;
};

struct PageSelection {
  std::vector<std::uint32_t> candidate_pages;
  std::vector<std::uint32_t> pruned_pages;
  std::vector<RowRange> row_ranges;

  // False when at least one candidate page has no OffsetIndex entry.  In that
  // case row_ranges is either the whole chunk (when num_rows is known) or
  // empty; callers must not treat an empty range list as "nothing matches".
  bool row_ranges_complete = true;
  std::int64_t num_rows = -1;
};

PageSelection select_pages(const ColumnDescriptor& descriptor,
                           const ColumnIndex& column_index,
                           const OffsetIndex& offset_index,
                           const Expr& expression,
                           const PruningOptions& options = {});

PageSelection select_pages(const ColumnDescriptor& descriptor,
                           const ColumnIndex& column_index,
                           const Expr& expression,
                           const PruningOptions& options = {});

std::vector<std::uint32_t> select_candidate_pages(
    const ColumnDescriptor& descriptor, const ColumnIndex& column_index,
    const Expr& expression, const PruningOptions& options = {});

std::vector<RowRange> page_row_ranges(
    const OffsetIndex& offset_index, std::span<const std::uint32_t> pages,
    std::int64_t num_rows = -1);

std::vector<RowRange> merge_row_ranges(std::vector<RowRange> ranges,
                                       bool merge_adjacent = true);

// Small embeddable wrapper.
class PageIndexPruner {
 public:
  explicit PageIndexPruner(ColumnDescriptor descriptor,
                           PruningOptions options = {});

  const ColumnDescriptor& descriptor() const { return descriptor_; }
  const PruningOptions& options() const { return options_; }

  Truth evaluate(const ColumnIndex& index, std::size_t page,
                 const Expr& expression) const;

  PageSelection select(const ColumnIndex& column_index,
                       const OffsetIndex& offset_index,
                       const Expr& expression) const;

  PageSelection select(const ColumnIndex& column_index,
                       const Expr& expression) const;

  std::vector<std::uint32_t> candidate_pages(
      const ColumnIndex& index, const Expr& expression) const;

 private:
  ColumnDescriptor descriptor_;
  PruningOptions options_;
};

// ---------------------------------------------------------------------------
// Per-row scan oracle
// ---------------------------------------------------------------------------

// Encoded value from a materialized page.  A null value has is_null=true and
// an empty bytes field.  A repeated row is represented by several values.
struct ScannedValue {
  bool is_null = true;
  std::string bytes;

  static ScannedValue Null();
  static ScannedValue FromLiteral(const Literal& literal);
};

struct ScannedPage {
  std::uint32_t page_index = 0;
  std::int64_t first_row_index = 0;
  std::vector<std::vector<ScannedValue>> rows;
};

// Three-valued logic; only Tri::True is a match.
enum class Tri : std::uint8_t { False = 0, True, Null };

Tri evaluate_row(const ColumnDescriptor& descriptor, const Expr& expression,
                 const std::vector<ScannedValue>& row);

struct VerificationReport {
  bool ok = true;
  std::size_t matching_rows = 0;
  std::vector<std::int64_t> missed_rows;
  std::vector<std::uint32_t> matching_pages_not_selected;
  std::vector<std::uint32_t> selected_pages_without_match;
};

// Cross-checks a selection against materialized pages.  It reports any row
// that evaluates to TRUE but falls outside the selected page/row ranges.
// Extra candidate pages are reported as false positives but do not make
// ok=false.
VerificationReport verify_selection(
    const PageSelection& selection, std::span<const ScannedPage> scanned_pages,
    const ColumnDescriptor& descriptor, const Expr& expression);

// Page-level variant that ignores row ranges.  Useful when only the candidate
// page set is being validated.
VerificationReport verify_page_selection(
    std::span<const std::uint32_t> candidate_pages,
    std::span<const ScannedPage> scanned_pages,
    const ColumnDescriptor& descriptor, const Expr& expression);

}  // namespace dataeng
