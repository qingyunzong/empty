#pragma once

// rope: an immutable, persistent rope (cord) over bytes.
//
// - Byte-oriented: slice / concat / replace operate on byte offsets.
// - Persistent: every derived rope shares nodes with its ancestors; old
//   views stay valid and unchanged forever (no copy-on-write, no mutation).
// - Cached length: every node caches its total byte length; concatenation
//   checks for size_t overflow before allocating a node.
// - UTF-8 boundary queries are defined over the flattened byte sequence,
//   so arbitrary split points (even mid-codepoint) never affect them.
// - Reclamation safety: nodes are held by std::shared_ptr<const node>;
//   a node is freed exactly when the last rope referencing it dies.

#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace rope {

namespace detail {

struct node {
  enum class kind_t : std::uint8_t { leaf, concat };

  kind_t kind;
  std::size_t len = 0;     // cached total byte length of the subtree
  std::uint32_t depth = 1; // cached tree depth, drives rebalancing

  // leaf payload: a window into a shared, immutable buffer
  std::shared_ptr<const std::string> data;
  std::size_t offset = 0;

  // concat payload
  std::shared_ptr<const node> left;
  std::shared_ptr<const node> right;
};

using node_ptr = std::shared_ptr<const node>;

// Overflow-checked addition of two cached lengths.
constexpr std::optional<std::size_t> checked_add(std::size_t a,
                                                 std::size_t b) noexcept {
  if (a > std::numeric_limits<std::size_t>::max() - b) return std::nullopt;
  return a + b;
}

inline node_ptr make_leaf(std::shared_ptr<const std::string> data,
                          std::size_t offset, std::size_t len) {
  auto n = std::make_shared<node>();
  n->kind = node::kind_t::leaf;
  n->len = len;
  n->depth = 1;
  n->data = std::move(data);
  n->offset = offset;
  return n;
}

inline node_ptr make_concat(node_ptr left, node_ptr right) {
  const auto total = checked_add(left->len, right->len);
  if (!total.has_value())
    throw std::length_error("rope: concatenated length overflows size_t");
  auto n = std::make_shared<node>();
  n->kind = node::kind_t::concat;
  n->len = *total;
  n->depth =
      (left->depth > right->depth ? left->depth : right->depth) + 1u;
  n->left = std::move(left);
  n->right = std::move(right);
  return n;
}

// Maximum bytes stored in a single leaf produced by rope::from.
inline constexpr std::size_t k_leaf_chunk = 1024;
// Rebalance when a concat would produce a tree deeper than this.
inline constexpr std::uint32_t k_rebalance_depth = 128;

// Iteratively collect the leaves of a tree in left-to-right order.
inline std::vector<node_ptr> collect_leaves(const node_ptr& root) {
  std::vector<node_ptr> leaves;
  std::vector<node_ptr> stack{root};
  while (!stack.empty()) {
    node_ptr n = std::move(stack.back());
    stack.pop_back();
    if (n->kind == node::kind_t::leaf) {
      leaves.push_back(std::move(n));
    } else {
      stack.push_back(n->right);
      stack.push_back(n->left);
    }
  }
  return leaves;
}

// Build a balanced tree over already-existing leaves (shares nodes).
inline node_ptr build_balanced(const std::vector<node_ptr>& leaves,
                               std::size_t lo, std::size_t hi) {
  if (hi - lo == 1) return leaves[lo];
  const std::size_t mid = lo + (hi - lo) / 2;
  return make_concat(build_balanced(leaves, lo, mid),
                     build_balanced(leaves, mid, hi));
}

} // namespace detail

class rope {
public:
  rope() = default;

  // Build a rope from a byte string, chunking into bounded-size leaves.
  static rope from(std::string_view text) {
    if (text.empty()) return rope();
    auto data = std::make_shared<const std::string>(text);
    std::vector<detail::node_ptr> leaves;
    for (std::size_t pos = 0; pos < data->size();) {
      const std::size_t n =
          data->size() - pos < detail::k_leaf_chunk ? data->size() - pos
                                                    : detail::k_leaf_chunk;
      leaves.push_back(detail::make_leaf(data, pos, n));
      pos += n;
    }
    return rope(detail::build_balanced(leaves, 0, leaves.size()));
  }

  std::size_t size() const { return root_ ? root_->len : 0; }
  bool empty() const { return root_ == nullptr; }
  std::uint32_t depth() const { return root_ ? root_->depth : 0; }

  // Byte access, bounds-checked. O(depth).
  char operator[](std::size_t pos) const {
    if (pos >= size()) throw std::out_of_range("rope: index out of range");
    const detail::node* n = root_.get();
    while (n->kind == detail::node::kind_t::concat) {
      if (pos < n->left->len) {
        n = n->left.get();
      } else {
        pos -= n->left->len;
        n = n->right.get();
      }
    }
    return (*n->data)[n->offset + pos];
  }

  // Persistent concatenation. Old ropes are untouched.
  rope concat(const rope& other) const {
    if (empty()) return other;
    if (other.empty()) return *this;
    detail::node_ptr root = detail::make_concat(root_, other.root_);
    if (root->depth > detail::k_rebalance_depth) {
      auto leaves = detail::collect_leaves(root);
      root = detail::build_balanced(leaves, 0, leaves.size());
    }
    return rope(std::move(root));
  }

  // Byte slice [pos, pos+len). Throws std::out_of_range on bad ranges.
  rope slice(std::size_t pos, std::size_t len) const {
    if (pos > size() || len > size() - pos)
      throw std::out_of_range("rope: slice range out of bounds");
    if (len == 0) return rope();
    if (pos == 0 && len == size()) return *this;
    return rope(slice_node(root_, pos, len));
  }

  // Replace bytes [pos, pos+len) with `with`. Persistent.
  rope replace(std::size_t pos, std::size_t len, const rope& with) const {
    if (pos > size() || len > size() - pos)
      throw std::out_of_range("rope: replace range out of bounds");
    return slice(0, pos).concat(with).concat(slice(pos + len, size() - pos - len));
  }

  rope replace(std::size_t pos, std::size_t len, std::string_view with) const {
    return replace(pos, len, rope::from(with));
  }

  // Flatten to a contiguous string. O(size).
  std::string to_string() const {
    std::string out;
    out.reserve(size());
    if (!root_) return out;
    std::vector<const detail::node*> stack{root_.get()};
    while (!stack.empty()) {
      const detail::node* n = stack.back();
      stack.pop_back();
      if (n->kind == detail::node::kind_t::leaf) {
        out.append(*n->data, n->offset, n->len);
      } else {
        stack.push_back(n->right.get());
        stack.push_back(n->left.get());
      }
    }
    return out;
  }

  // --- UTF-8 boundary queries (byte offsets) ---------------------------
  // These read the flattened byte sequence through operator[], so they are
  // correct no matter where the tree happens to be split, even if a split
  // falls in the middle of a multi-byte codepoint.

  // True if `pos` is a UTF-8 codepoint boundary (0 and size() count).
  bool is_char_boundary(std::size_t pos) const {
    if (pos > size()) return false;
    if (pos == 0 || pos == size()) return true;
    return (static_cast<unsigned char>((*this)[pos]) & 0xC0) != 0x80;
  }

  // Largest boundary <= pos (pos is clamped to size()).
  std::size_t floor_char_boundary(std::size_t pos) const {
    if (pos > size()) pos = size();
    while (pos > 0 && !is_char_boundary(pos)) --pos;
    return pos;
  }

  // Smallest boundary >= pos (pos is clamped to size()).
  std::size_t ceil_char_boundary(std::size_t pos) const {
    if (pos > size()) pos = size();
    while (pos < size() && !is_char_boundary(pos)) ++pos;
    return pos;
  }

  // Diagnostics handle for tests: observe reclamation of the root node.
  std::weak_ptr<const detail::node> debug_node() const { return root_; }

private:
  explicit rope(detail::node_ptr root) : root_(std::move(root)) {}

  static detail::node_ptr slice_node(const detail::node_ptr& n,
                                     std::size_t pos, std::size_t len) {
    if (pos == 0 && len == n->len) return n;
    if (n->kind == detail::node::kind_t::leaf)
      return detail::make_leaf(n->data, n->offset + pos, len);
    const std::size_t left_len = n->left->len;
    if (pos + len <= left_len) return slice_node(n->left, pos, len);
    if (pos >= left_len) return slice_node(n->right, pos - left_len, len);
    return detail::make_concat(slice_node(n->left, pos, left_len - pos),
                               slice_node(n->right, 0, pos + len - left_len));
  }

  detail::node_ptr root_;
};

} // namespace rope
