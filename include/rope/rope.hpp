#pragma once

// rope: a persistent (immutable) rope for byte strings.
//
//  * Byte-level slice / concat / replace; every operation returns a new
//    Rope and leaves the receiver untouched, so old views stay valid.
//  * Each node caches its byte length; concatenation uses checked
//    addition and throws std::length_error instead of overflowing.
//  * Nodes are shared through std::shared_ptr<const Node>; reclamation
//    is automatic once the last view referencing a node is dropped.
//  * UTF-8 boundary queries (is/floor/ceil_char_boundary) are answered
//    by inspecting bytes across node boundaries, so slicing at any byte
//    offset -- even inside a multi-byte sequence -- never breaks them.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace rope {

namespace detail {

inline size_t checked_add(size_t a, size_t b) {
    if (a > std::numeric_limits<size_t>::max() - b)
        throw std::length_error("rope: length overflow");
    return a + b;
}

} // namespace detail

struct Node {
    enum class Kind : uint8_t { Leaf, Concat };

    Kind kind;
    size_t length;    // cached byte length of the subtree
    uint32_t height;  // 1 for leaves

    // Leaf payload / Concat children (mutually exclusive).
    std::string data;
    std::shared_ptr<const Node> left;
    std::shared_ptr<const Node> right;

    // Diagnostic: number of live nodes, used by the lifetime tests.
    static std::atomic<size_t> live_count;

    explicit Node(std::string s)
        : kind(Kind::Leaf), length(s.size()), height(1), data(std::move(s)) {
        live_count.fetch_add(1, std::memory_order_relaxed);
    }

    Node(std::shared_ptr<const Node> l, std::shared_ptr<const Node> r)
        : kind(Kind::Concat),
          length(detail::checked_add(l->length, r->length)),
          height(1 + (l->height > r->height ? l->height : r->height)),
          left(std::move(l)),
          right(std::move(r)) {
        live_count.fetch_add(1, std::memory_order_relaxed);
    }

    ~Node() { live_count.fetch_sub(1, std::memory_order_relaxed); }

    Node(const Node&) = delete;
    Node& operator=(const Node&) = delete;
};

inline std::atomic<size_t> Node::live_count{0};

class Rope {
public:
    // Maximum payload of a single leaf; larger inputs are chunked.
    static constexpr size_t kLeafSize = 1024;
    // Rebalance once the tree gets deeper than this.
    static constexpr uint32_t kMaxHeight = 64;

    Rope() = default;

    static Rope from(std::string_view sv) {
        Rope r;
        r.root_ = build_from(sv);
        return r;
    }

    size_t size() const { return root_ ? root_->length : 0; }
    bool empty() const { return size() == 0; }

    // Number of live nodes in the whole process (test diagnostics).
    static size_t live_node_count() {
        return Node::live_count.load(std::memory_order_relaxed);
    }

    // ------------------------------------------------------------------
    // Structural operations (all non-mutating; old views stay valid).
    // ------------------------------------------------------------------

    Rope concat(const Rope& other) const {
        Rope out;
        out.root_ = concat_nodes(root_, other.root_);
        return out;
    }

    // Byte-range view [pos, pos+len). Shares untouched subtrees.
    Rope slice(size_t pos, size_t len) const {
        check_range(pos, len);
        Rope out;
        if (root_ && len > 0)
            out.root_ = slice_node(root_, pos, len);
        return out;
    }

    Rope insert(size_t pos, const Rope& text) const {
        return replace(pos, 0, text);
    }

    Rope insert(size_t pos, std::string_view text) const {
        return insert(pos, Rope::from(text));
    }

    Rope erase(size_t pos, size_t len) const {
        return replace(pos, len, Rope{});
    }

    Rope replace(size_t pos, size_t len, const Rope& text) const {
        check_range(pos, len);
        Rope out;
        Ptr head = (root_ && pos > 0) ? slice_node(root_, 0, pos) : nullptr;
        Ptr tail = (root_ && pos + len < size())
                       ? slice_node(root_, pos + len, size() - pos - len)
                       : nullptr;
        out.root_ = concat_nodes(concat_nodes(head, text.root_), tail);
        return out;
    }

    Rope replace(size_t pos, size_t len, std::string_view text) const {
        return replace(pos, len, Rope::from(text));
    }

    // ------------------------------------------------------------------
    // Byte access and materialisation.
    // ------------------------------------------------------------------

    char byte_at(size_t pos) const {
        if (pos >= size())
            throw std::out_of_range("rope: byte_at");
        const Node* n = root_.get();
        while (n->kind == Node::Kind::Concat) {
            if (pos < n->left->length) {
                n = n->left.get();
            } else {
                pos -= n->left->length;
                n = n->right.get();
            }
        }
        return n->data[pos];
    }

    std::string to_string() const {
        std::string out;
        out.reserve(size());
        append_to(root_, out);
        return out;
    }

    // ------------------------------------------------------------------
    // UTF-8 boundary queries. Positions are byte offsets. These work on
    // bytes fetched across node boundaries, so arbitrary split points
    // (including splits inside a multi-byte sequence) never break them.
    // ------------------------------------------------------------------

    static bool is_continuation(unsigned char b) { return (b & 0xC0) == 0x80; }

    bool is_char_boundary(size_t pos) const {
        if (pos > size())
            throw std::out_of_range("rope: is_char_boundary");
        if (pos == 0 || pos == size())
            return true;
        return !is_continuation(static_cast<unsigned char>(byte_at(pos)));
    }

    // Greatest boundary <= pos.
    size_t floor_char_boundary(size_t pos) const {
        if (pos > size())
            pos = size();
        while (pos > 0 && !is_char_boundary(pos))
            --pos;
        return pos;
    }

    // Smallest boundary >= pos.
    size_t ceil_char_boundary(size_t pos) const {
        if (pos > size())
            pos = size();
        while (pos < size() && !is_char_boundary(pos))
            ++pos;
        return pos;
    }

private:
    using Ptr = std::shared_ptr<const Node>;

    Ptr root_;

    void check_range(size_t pos, size_t len) const {
        if (pos > size() || len > size() - pos)
            throw std::out_of_range("rope: range out of bounds");
    }

    static Ptr make_leaf(std::string s) {
        if (s.empty())
            return nullptr;
        return std::make_shared<Node>(std::move(s));
    }

    static Ptr concat_nodes(Ptr a, Ptr b) {
        if (!a)
            return b;
        if (!b)
            return a;
        // Merge small adjacent leaves to keep the leaf count down.
        if (a->kind == Node::Kind::Leaf && b->kind == Node::Kind::Leaf &&
            a->length + b->length <= kLeafSize) {
            return make_leaf(a->data + b->data);
        }
        Ptr node = std::make_shared<Node>(std::move(a), std::move(b));
        if (node->height > kMaxHeight)
            node = rebalance(node);
        return node;
    }

    static Ptr slice_node(const Ptr& n, size_t pos, size_t len) {
        if (pos == 0 && len == n->length)
            return n; // share the whole subtree
        if (n->kind == Node::Kind::Leaf)
            return make_leaf(n->data.substr(pos, len));
        size_t left_len = n->left->length;
        if (pos + len <= left_len)
            return slice_node(n->left, pos, len);
        if (pos >= left_len)
            return slice_node(n->right, pos - left_len, len);
        Ptr l = slice_node(n->left, pos, left_len - pos);
        Ptr r = slice_node(n->right, 0, pos + len - left_len);
        return concat_nodes(std::move(l), std::move(r));
    }

    static Ptr build_from(std::string_view sv) {
        if (sv.empty())
            return nullptr;
        std::vector<Ptr> leaves;
        for (size_t off = 0; off < sv.size(); off += kLeafSize) {
            size_t n = sv.size() - off < kLeafSize ? sv.size() - off : kLeafSize;
            leaves.push_back(std::make_shared<Node>(std::string(sv.substr(off, n))));
        }
        return build_balanced(leaves, 0, leaves.size());
    }

    static Ptr build_balanced(const std::vector<Ptr>& leaves, size_t lo, size_t hi) {
        if (hi - lo == 1)
            return leaves[lo];
        size_t mid = lo + (hi - lo) / 2;
        return std::make_shared<Node>(build_balanced(leaves, lo, mid),
                                      build_balanced(leaves, mid, hi));
    }

    static void flatten(const Ptr& n, std::vector<Ptr>& out) {
        if (n->kind == Node::Kind::Leaf) {
            out.push_back(n);
        } else {
            flatten(n->left, out);
            flatten(n->right, out);
        }
    }

    // Rebuild a balanced tree reusing the existing (immutable) leaves.
    static Ptr rebalance(const Ptr& n) {
        std::vector<Ptr> leaves;
        flatten(n, leaves);
        return build_balanced(leaves, 0, leaves.size());
    }

    static void append_to(const Ptr& n, std::string& out) {
        if (!n)
            return;
        if (n->kind == Node::Kind::Leaf) {
            out.append(n->data);
        } else {
            append_to(n->left, out);
            append_to(n->right, out);
        }
    }
};

} // namespace rope
