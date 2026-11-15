#include "dataeng.hpp"

#include <algorithm>
#include <sstream>

namespace dataeng {
namespace {

SliceStatus Fail(SliceError code, std::string message) {
  return SliceStatus{code, std::move(message)};
}

// Finds the child slot whose Arrow type code equals `type_id`.
int FindSlot(const ArrayNode& node, std::int8_t type_id) {
  for (int slot = 0; slot < static_cast<int>(node.type_codes.size()); ++slot) {
    if (node.type_codes[slot] == type_id) {
      return slot;
    }
  }
  return -1;
}

SliceStatus CheckParentRange(const ArrayNode& node, std::int64_t offset,
                             std::int64_t length) {
  if (offset < 0 || length < 0 || offset > node.length ||
      node.length - offset < length) {
    std::ostringstream oss;
    oss << "slice [" << offset << ", " << (offset + length)
        << ") is outside array of length " << node.length;
    return Fail(SliceError::ParentOutOfBounds, oss.str());
  }
  return SliceStatus{};
}

// Validates union layout and referenced child offsets. Runs for both
// strategies so out-of-bounds dense offsets fail immediately.
SliceStatus ValidateUnion(const ArrayNode& node, std::int64_t offset,
                          std::int64_t length) {
  if (node.type_codes.size() != node.children.size()) {
    return Fail(SliceError::InvalidLayout,
                "type_codes and children must have the same size");
  }
  if (length > 0 && node.type_ids == nullptr) {
    return Fail(SliceError::InvalidLayout,
                "union with non-zero length must provide a type id buffer");
  }
  if (node.union_mode == UnionMode::Dense && length > 0 &&
      node.value_offsets == nullptr) {
    return Fail(SliceError::InvalidLayout,
                "dense union with non-zero length must provide offsets");
  }

  for (std::int64_t row = 0; row < length; ++row) {
    const std::int64_t physical = node.offset + offset + row;
    const std::int8_t type_id = node.type_ids[physical];
    const int slot = FindSlot(node, type_id);
    if (slot < 0) {
      std::ostringstream oss;
      oss << "type id " << static_cast<int>(type_id) << " at row " << row
          << " has no matching child";
      return Fail(SliceError::InvalidTypeId, oss.str());
    }

    const ArrayNode& child = node.children[slot];
    if (node.union_mode == UnionMode::Dense) {
      const std::int32_t stored = node.value_offsets[physical];
      if (stored < 0 ||
          static_cast<std::int64_t>(stored) >= child.offset + child.length) {
        std::ostringstream oss;
        oss << "dense value offset " << stored << " at row " << row
            << " (type id " << static_cast<int>(type_id)
            << ") is outside child physical length "
            << (child.offset + child.length);
        return Fail(SliceError::DenseOffsetOutOfBounds, oss.str());
      }
    } else if (child.offset + offset < 0 ||
               offset + length > child.length) {
      std::ostringstream oss;
      oss << "sparse child (type id " << static_cast<int>(type_id)
          << ") of logical length " << child.length
          << " cannot cover slice length " << length << " at offset " << offset;
      return Fail(SliceError::DenseOffsetOutOfBounds, oss.str());
    }
  }
  return SliceStatus{};
}

// Retains, in first-reference order, only slots referenced by the slice rows.
std::vector<int> ReferencedSlots(const ArrayNode& node, std::int64_t offset,
                                 std::int64_t length) {
  std::vector<int> slots;
  for (std::int64_t row = 0; row < length; ++row) {
    const std::int8_t type_id = node.type_ids[node.offset + offset + row];
    const int slot = FindSlot(node, type_id);
    if (std::find(slots.begin(), slots.end(), slot) == slots.end()) {
      slots.push_back(slot);
    }
  }
  return slots;
}

// Zero-copy recursion. Union buffers are shared verbatim; only the parent
// offset changes and unreferenced children are dropped.
SliceResult ZeroCopyImpl(const ArrayNode& node, std::int64_t offset,
                         std::int64_t length) {
  SliceResult result;
  if (!node.is_union) {
    result.array = node;
    result.array.length = length;
    result.array.offset = node.offset + offset;
    result.status = SliceStatus{};
    return result;
  }

  result.status = ValidateUnion(node, offset, length);
  if (!result.status.ok()) {
    return result;
  }

  result.array = node;
  result.array.length = length;
  result.array.offset = node.offset + offset;
  result.array.owned_type_ids.reset();
  result.array.owned_value_offsets.reset();
  result.array.owned_values.reset();

  const std::vector<int> slots = ReferencedSlots(node, offset, length);
  std::vector<std::int8_t> codes;
  std::vector<ArrayNode> kept;
  codes.reserve(slots.size());
  kept.reserve(slots.size());
  for (int slot : slots) {
    codes.push_back(node.type_codes[slot]);
    // A zero-copy view never re-slices shared child buffers: a child
    // (including a nested union) keeps its own buffers and parent offset.
    kept.push_back(node.children[slot]);
  }
  result.array.type_codes = std::move(codes);
  result.array.children = std::move(kept);
  result.status = SliceStatus{};
  return result;
}

// Safe-rewrite recursion. The returned node is compact: parent offset zero,
// copied type ids, rebased dense offsets, recursively sliced children.
SliceResult RewriteImpl(const ArrayNode& node, std::int64_t offset,
                        std::int64_t length) {
  SliceResult result;
  if (!node.is_union) {
    result.array = node;
    result.array.length = length;
    result.array.offset = node.offset + offset;
    result.status = SliceStatus{};
    return result;
  }

  result.status = ValidateUnion(node, offset, length);
  if (!result.status.ok()) {
    return result;
  }

  const std::vector<int> slots = ReferencedSlots(node, offset, length);

  auto owned_type_ids = std::make_shared<std::vector<std::int8_t>>();
  owned_type_ids->reserve(static_cast<std::size_t>(length));
  for (std::int64_t row = 0; row < length; ++row) {
    owned_type_ids->push_back(node.type_ids[node.offset + offset + row]);
  }

  std::vector<std::int8_t> codes;
  std::vector<ArrayNode> children;
  codes.reserve(slots.size());
  children.reserve(slots.size());

  std::shared_ptr<std::vector<std::int32_t>> owned_offsets;
  if (node.union_mode == UnionMode::Dense) {
    owned_offsets = std::make_shared<std::vector<std::int32_t>>();
    owned_offsets->resize(static_cast<std::size_t>(length));
  }

  if (node.union_mode == UnionMode::Sparse) {
    // Referenced children are rewritten over the same relative range;
    // unreferenced children are excluded entirely.
    for (int slot : slots) {
      SliceResult child_result =
          RewriteImpl(node.children[slot], offset, length);
      if (!child_result.status.ok()) {
        result.status = child_result.status;
        return result;
      }
      codes.push_back(node.type_codes[slot]);
      children.push_back(std::move(child_result.array));
    }
  } else {
    // For each type code find the referenced child window, compact the child
    // to it, then rebase dense offsets relative to the window base.
    for (int slot : slots) {
      const std::int8_t type_id = node.type_codes[slot];
      std::int32_t min_physical = 0;
      std::int32_t max_physical = -1;
      bool seen = false;
      for (std::int64_t row = 0; row < length; ++row) {
        const std::int64_t physical = node.offset + offset + row;
        if (node.type_ids[physical] != type_id) {
          continue;
        }
        const std::int32_t stored = node.value_offsets[physical];
        if (!seen || stored < min_physical) {
          min_physical = stored;
        }
        if (!seen || stored > max_physical) {
          max_physical = stored;
        }
        seen = true;
      }

      const ArrayNode& child = node.children[slot];
      const std::int64_t relative_base =
          static_cast<std::int64_t>(min_physical) - child.offset;
      const std::int64_t child_length =
          static_cast<std::int64_t>(max_physical) - min_physical + 1;
      SliceResult child_result =
          RewriteImpl(child, relative_base, child_length);
      if (!child_result.status.ok()) {
        result.status = child_result.status;
        return result;
      }
      codes.push_back(type_id);
      children.push_back(std::move(child_result.array));

      // Normalize the compacted child to a zero base: leaf buffers are
      // borrowed with the pointer advanced (still zero copy), nested rewritten
      // unions already carry offset zero.
      ArrayNode& compacted = children.back();
      if (!compacted.is_union && compacted.offset > 0) {
        compacted.values =
            static_cast<const unsigned char*>(compacted.values) +
            static_cast<std::size_t>(compacted.offset) * compacted.value_size;
        compacted.offset = 0;
      }

      for (std::int64_t row = 0; row < length; ++row) {
        const std::int64_t physical = node.offset + offset + row;
        if (node.type_ids[physical] != type_id) {
          continue;
        }
        (*owned_offsets)[static_cast<std::size_t>(row)] =
            node.value_offsets[physical] - min_physical;
      }
    }
  }

  result.array = ArrayNode{};
  result.array.is_union = true;
  result.array.union_mode = node.union_mode;
  result.array.length = length;
  result.array.offset = 0;
  result.array.owned_type_ids = owned_type_ids;
  result.array.type_ids = owned_type_ids->data();
  result.array.type_codes = std::move(codes);
  result.array.children = std::move(children);
  if (owned_offsets) {
    result.array.owned_value_offsets = owned_offsets;
    result.array.value_offsets = owned_offsets->data();
  }
  result.status = SliceStatus{};
  return result;
}

bool LeafEquals(const ArrayNode& lhs, const ArrayNode& rhs) {
  if (lhs.length != rhs.length || lhs.value_size != rhs.value_size) {
    return false;
  }
  if (lhs.length == 0) {
    return true;
  }
  const auto* left =
      static_cast<const unsigned char*>(lhs.values) +
      static_cast<std::size_t>(lhs.offset) * lhs.value_size;
  const auto* right =
      static_cast<const unsigned char*>(rhs.values) +
      static_cast<std::size_t>(rhs.offset) * rhs.value_size;
  return std::equal(
      left,
      left + static_cast<std::size_t>(lhs.length) * lhs.value_size, right);
}

}  // namespace

ArrayNode MakeLeaf(const void* values, std::size_t value_size,
                   std::int64_t length, std::int64_t offset) {
  ArrayNode node;
  node.is_union = false;
  node.length = length;
  node.offset = offset;
  node.values = values;
  node.value_size = value_size;
  return node;
}

ArrayNode MakeUnion(UnionMode mode, std::int64_t length,
                    const std::int8_t* type_ids,
                    const std::int32_t* value_offsets,
                    std::vector<std::int8_t> type_codes,
                    std::vector<ArrayNode> children,
                    std::int64_t offset) {
  ArrayNode node;
  node.is_union = true;
  node.union_mode = mode;
  node.length = length;
  node.offset = offset;
  node.type_ids = type_ids;
  node.value_offsets = value_offsets;
  node.type_codes = std::move(type_codes);
  node.children = std::move(children);
  return node;
}

SliceResult Slice(const ArrayNode& array, std::int64_t offset,
                  std::int64_t length, SliceStrategy strategy) {
  SliceResult result;
  result.status = CheckParentRange(array, offset, length);
  if (!result.status.ok()) {
    return result;
  }
  if (strategy == SliceStrategy::ZeroCopy) {
    return ZeroCopyImpl(array, offset, length);
  }
  return RewriteImpl(array, offset, length);
}

SliceResult ZeroCopySlice(const ArrayNode& array, std::int64_t offset,
                          std::int64_t length) {
  return Slice(array, offset, length, SliceStrategy::ZeroCopy);
}

SliceResult RewriteSlice(const ArrayNode& array, std::int64_t offset,
                         std::int64_t length) {
  return Slice(array, offset, length, SliceStrategy::SafeRewrite);
}

std::vector<std::int8_t> ReferencedTypeCodes(const ArrayNode& node) {
  std::vector<std::int8_t> codes;
  if (!node.is_union) {
    return codes;
  }
  for (std::int64_t row = 0; row < node.length; ++row) {
    const std::int8_t type_id = node.type_ids[node.offset + row];
    if (std::find(codes.begin(), codes.end(), type_id) == codes.end()) {
      codes.push_back(type_id);
    }
  }
  return codes;
}

bool LogicalEquals(const ArrayNode& lhs, const ArrayNode& rhs) {
  if (lhs.is_union != rhs.is_union || lhs.length != rhs.length) {
    return false;
  }
  if (!lhs.is_union) {
    return LeafEquals(lhs, rhs);
  }
  if (lhs.union_mode != rhs.union_mode) {
    return false;
  }
  for (std::int64_t row = 0; row < lhs.length; ++row) {
    if (lhs.type_ids[lhs.offset + row] !=
        rhs.type_ids[rhs.offset + row]) {
      return false;
    }
  }

  if (lhs.union_mode == UnionMode::Dense) {
    // Compare resolved values through each row's child offset so that rebased
    // vs. absolute offsets compare equal.
    for (std::int64_t row = 0; row < lhs.length; ++row) {
      const std::int8_t type_id = lhs.type_ids[lhs.offset + row];
      if (type_id != rhs.type_ids[rhs.offset + row]) {
        return false;
      }
      int left_slot = -1;
      int right_slot = -1;
      for (int slot = 0;
           slot < static_cast<int>(lhs.type_codes.size()); ++slot) {
        if (lhs.type_codes[slot] == type_id) {
          left_slot = slot;
        }
      }
      for (int slot = 0;
           slot < static_cast<int>(rhs.type_codes.size()); ++slot) {
        if (rhs.type_codes[slot] == type_id) {
          right_slot = slot;
        }
      }
      if (left_slot < 0 || right_slot < 0) {
        return false;
      }
      const ArrayNode& left_child = lhs.children[left_slot];
      const ArrayNode& right_child = rhs.children[right_slot];
      const std::int64_t left_index =
          lhs.value_offsets[lhs.offset + row] - left_child.offset;
      const std::int64_t right_index =
          rhs.value_offsets[rhs.offset + row] - right_child.offset;
      if (left_index < 0 || right_index < 0 ||
          left_index >= left_child.length || right_index >= right_child.length) {
        return false;
      }
      if (left_child.is_union || right_child.is_union) {
        SliceResult l = ZeroCopySlice(left_child, left_index, 1);
        SliceResult r = ZeroCopySlice(right_child, right_index, 1);
        if (!l.status.ok() || !r.status.ok() ||
            !LogicalEquals(l.array, r.array)) {
          return false;
        }
        continue;
      }
      if (left_child.value_size != right_child.value_size) {
        return false;
      }
      const auto* lp = static_cast<const unsigned char*>(left_child.values) +
                       static_cast<std::size_t>(left_child.offset + left_index) *
                           left_child.value_size;
      const auto* rp =
          static_cast<const unsigned char*>(right_child.values) +
          static_cast<std::size_t>(right_child.offset + right_index) *
              right_child.value_size;
      if (!std::equal(lp, lp + left_child.value_size, rp)) {
        return false;
      }
    }
    return true;
  }

  // Sparse: compare referenced children recursively at the same rows.
  if (lhs.type_codes.size() != rhs.type_codes.size()) {
    return false;
  }
  for (int left_slot = 0;
       left_slot < static_cast<int>(lhs.type_codes.size()); ++left_slot) {
    const std::int8_t type_id = lhs.type_codes[left_slot];
    int right_slot = -1;
    for (int slot = 0; slot < static_cast<int>(rhs.type_codes.size());
         ++slot) {
      if (rhs.type_codes[slot] == type_id) {
        right_slot = slot;
      }
    }
    if (right_slot < 0 ||
        !LogicalEquals(lhs.children[left_slot], rhs.children[right_slot])) {
      return false;
    }
  }
  return true;
}

}  // namespace dataeng
