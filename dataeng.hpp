#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// Embeddable, zero-dependency Arrow dense/sparse union slicing library.
//
// The library models the buffer-level layout of Arrow union arrays (type id
// buffer, dense value offsets buffer, parent offset/length) without depending on
// an Arrow runtime. Buffers are always *borrowed* by descriptors; only the
// safe-rewrite path owns freshly allocated, rewritten buffers.
namespace dataeng {

enum class UnionMode : std::uint8_t {
  Sparse = 0,
  Dense = 1,
};

enum class SliceError {
  None = 0,
  ParentOutOfBounds,
  InvalidLayout,
  InvalidTypeId,
  DenseOffsetOutOfBounds,
};

struct SliceStatus {
  SliceError code = SliceError::None;
  std::string message;

  bool ok() const noexcept { return code == SliceError::None; }
  explicit operator bool() const noexcept { return ok(); }
};

// Borrowed view (or rewritten, owned representation) of one array node.
//
// A node is either a flat/leaf array or a union. For a leaf, `values` points at
// the first element of the physical buffer and `value_size` is its element byte
// width. For a union, the type id / dense offset buffers and `children` carry
// the union layout.
//
// `offset` is the Arrow-style parent offset of the described array inside its
// physical buffers. Borrowed views keep offsets absolute and never copy;
// rewritten nodes set `offset == 0` and own compacted buffers.
struct ArrayNode {
  bool is_union = false;
  UnionMode union_mode = UnionMode::Sparse;
  std::int64_t length = 0;
  std::int64_t offset = 0;

  // Leaf buffer (borrowed unless `owned_values` is populated).
  const void* values = nullptr;
  std::size_t value_size = 0;

  // Union physical buffers (borrowed unless the owned counterparts are used).
  const std::int8_t* type_ids = nullptr;
  const std::int32_t* value_offsets = nullptr;  // dense union only
  std::vector<std::int8_t> type_codes;          // child slot -> Arrow type code
  std::vector<ArrayNode> children;              // indexed by child slot

  // Owned, rewritten storage. When populated these own the memory referenced by
  // the corresponding borrowed pointer above.
  std::shared_ptr<std::vector<std::int8_t>> owned_type_ids;
  std::shared_ptr<std::vector<std::int32_t>> owned_value_offsets;
  std::shared_ptr<void> owned_values;
};

// Construct a leaf node describing `length` elements starting at `values`.
ArrayNode MakeLeaf(const void* values, std::size_t value_size,
                   std::int64_t length, std::int64_t offset = 0);

// Construct a union node. `type_codes[slot]` maps each child slot to its Arrow
// type code as stored in the type id buffer.
ArrayNode MakeUnion(UnionMode mode, std::int64_t length,
                    const std::int8_t* type_ids,
                    const std::int32_t* value_offsets,
                    std::vector<std::int8_t> type_codes,
                    std::vector<ArrayNode> children,
                    std::int64_t offset = 0);

struct SliceResult {
  SliceStatus status;
  ArrayNode array;
};

enum class SliceStrategy {
  // Never copies union buffers: the result shares the parent buffers with an
  // adjusted parent offset and only children actually referenced by the slice
  // are retained.
  ZeroCopy = 0,
  // Allocates a compact, self-contained representation. Dense value offsets are
  // rebased to zero and (recursively) only referenced children are kept.
  SafeRewrite = 1,
};

// Slice `array` at parent offset `offset` for `length` rows.
//
// Dense child offsets are validated eagerly (both strategies): any value
// offset resolving outside its child's physical length fails immediately with
// SliceError::DenseOffsetOutOfBounds.
SliceResult Slice(const ArrayNode& array, std::int64_t offset,
                  std::int64_t length, SliceStrategy strategy);

// Convenience wrappers around Slice().
SliceResult ZeroCopySlice(const ArrayNode& array, std::int64_t offset,
                          std::int64_t length);
SliceResult RewriteSlice(const ArrayNode& array, std::int64_t offset,
                         std::int64_t length);

// Arrow type codes referenced by the rows of a union node.
std::vector<std::int8_t> ReferencedTypeCodes(const ArrayNode& node);

// Logical equality: same values/type ids/rebased dense offsets and same child
// sets (compared by type code), independent of buffer addresses or parent
// offsets. Useful for asserting that nested slicing equals one slice.
bool LogicalEquals(const ArrayNode& lhs, const ArrayNode& rhs);

// Reads the logical type id of union row `index` (relative to node offset).
inline std::int8_t TypeIdAt(const ArrayNode& node, std::int64_t index) {
  return node.type_ids[node.offset + index];
}

// Reads the stored dense value offset of union row `index`.
inline std::int32_t DenseOffsetAt(const ArrayNode& node,
                                  std::int64_t index) {
  return node.value_offsets[node.offset + index];
}
}  // namespace dataeng
