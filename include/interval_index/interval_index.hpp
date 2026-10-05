// interval_index.hpp
//
// Persistent (immutable, copy-on-write) interval index for a single-writer /
// multi-reader workload.
//
// Design
// ------
// * The index maps half-open intervals [lo, hi) over int64_t to values of
//   type T.  Points that were never assigned have no value.
// * Segments are stored in a randomized treap keyed by interval start.
//   Nodes are immutable and reference counted with std::shared_ptr<const
//   node>; every update builds a new root that shares untouched subtrees
//   with the previous version (structural sharing).
// * The writer publishes a new version with a single atomic store of the
//   root pointer (std::atomic<std::shared_ptr>, C++20).  Readers obtain a
//   `snapshot` with one atomic load.  A snapshot keeps every node it can
//   reach alive, so node reclamation triggered by later publications can
//   never affect in-flight queries on old snapshots.
// * `apply()` (and the convenience `assign`/`add`) must be called from one
//   writer thread only.  `snap()`/`snapshot::query` are safe to call from
//   any number of reader threads concurrently with the writer.
//
// Composition order of assign / add
// ---------------------------------
// Operations inside one batch are applied strictly in the order they were
// added, and each operation observes the result of all previous ones:
//   * assign(lo, hi, v)  -- every point of [lo, hi) becomes exactly v,
//                           regardless of what was there before.
//   * add(lo, hi, d)     -- d is added to the *current* value of every
//                           point of [lo, hi) that has a value.  add never
//                           creates values on unassigned points.
// Therefore, for overlapping ranges:
//   add then assign  ==  assign alone      (assign wins, add is discarded)
//   assign then add  ==  assign of (v + d) (add accumulates onto assigned)
//
// Requirements on T: copy-constructible, equality-comparable (used for
// segment coalescing), and `t + t` must be valid for add().
//
// Complexity: assign/add/query are O(log n) expected; a batch of k ops is
// O(k log n).  Publishing and snapshotting are O(1).

#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace interval_index {

// One maximal half-open interval [lo, hi) carrying `value`.
template <typename T>
struct segment {
    std::int64_t lo;
    std::int64_t hi;
    T value;

    friend bool operator==(const segment&, const segment&) = default;
};

namespace detail {

constexpr std::uint64_t mix64(std::uint64_t x) {
    x += 0x9e3779b97f4a7c15ull;
    x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ull;
    x = (x ^ (x >> 27)) * 0x94d049bb133111ebull;
    return x ^ (x >> 31);
}

template <typename T>
struct node {
    std::int64_t lo;
    std::int64_t hi;
    T value;
    std::uint64_t prio;  // deterministic treap priority
    std::shared_ptr<const node> left;
    std::shared_ptr<const node> right;

    node(std::int64_t lo_, std::int64_t hi_, const T& v,
         std::shared_ptr<const node> l, std::shared_ptr<const node> r)
        : lo(lo_), hi(hi_), value(v),
          prio(mix64(mix64(static_cast<std::uint64_t>(lo_)) ^
                     static_cast<std::uint64_t>(hi_))),
          left(std::move(l)), right(std::move(r)) {}
};

// All persistent treap machinery.  Every function takes and returns trees
// by shared_ptr; nothing is ever mutated in place.
template <typename T, typename NodeAlloc>
class core {
public:
    using node_type = node<T>;
    using tree = std::shared_ptr<const node_type>;

    explicit core(NodeAlloc alloc) : alloc_(std::move(alloc)) {}

    tree make(std::int64_t lo, std::int64_t hi, const T& v,
              tree l = tree{}, tree r = tree{}) {
        return std::allocate_shared<node_type>(alloc_, lo, hi, v,
                                               std::move(l), std::move(r));
    }

    // Standard treap merge: every key in `a` precedes every key in `b`.
    tree merge(const tree& a, const tree& b) {
        if (!a) return b;
        if (!b) return a;
        if (a->prio < b->prio)
            return make(a->lo, a->hi, a->value, a->left, merge(a->right, b));
        return make(b->lo, b->hi, b->value, merge(a, b->left), b->right);
    }

    // Splits coverage at x: left tree covers (-inf, x), right tree covers
    // [x, +inf).  A segment straddling x is split into two new nodes.
    std::pair<tree, tree> split_at(const tree& t, std::int64_t x) {
        if (!t) return {tree{}, tree{}};
        if (x <= t->lo) {
            auto [l, r] = split_at(t->left, x);
            return {l, make(t->lo, t->hi, t->value, r, t->right)};
        }
        if (x >= t->hi) {
            auto [l, r] = split_at(t->right, x);
            return {make(t->lo, t->hi, t->value, t->left, l), r};
        }
        tree left_seg = make(t->lo, x, t->value);
        tree right_seg = make(x, t->hi, t->value);
        return {merge(t->left, left_seg), merge(right_seg, t->right)};
    }

    // {tree without rightmost segment, rightmost segment}
    std::pair<tree, tree> split_rightmost(const tree& t) {
        if (!t->right) return {t->left, t};
        auto [rest, mx] = split_rightmost(t->right);
        return {make(t->lo, t->hi, t->value, t->left, rest), mx};
    }

    // {tree without leftmost segment, leftmost segment}
    std::pair<tree, tree> split_leftmost(const tree& t) {
        if (!t->left) return {t->right, t};
        auto [rest, mn] = split_leftmost(t->left);
        return {make(t->lo, t->hi, t->value, rest, t->right), mn};
    }

    static const node_type* find(const tree& t, std::int64_t x) {
        const node_type* cur = t.get();
        while (cur) {
            if (x < cur->lo)
                cur = cur->left.get();
            else if (x >= cur->hi)
                cur = cur->right.get();
            else
                return cur;
        }
        return nullptr;
    }

    static void collect(const tree& t, std::vector<segment<T>>& out) {
        if (!t) return;
        collect(t->left, out);
        out.push_back(segment<T>{t->lo, t->hi, t->value});
        collect(t->right, out);
    }

    tree assign(const tree& root, std::int64_t lo, std::int64_t hi,
                const T& v) {
        auto [a, bc] = split_at(root, lo);
        auto [b, c] = split_at(bc, hi);  // b is overwritten, dropped
        // Coalesce with adjacent neighbours of equal value, but only when
        // truly adjacent (never fill an unassigned gap).
        if (a) {
            auto [rest, mx] = split_rightmost(a);
            if (mx->hi == lo && mx->value == v) {
                lo = mx->lo;
                a = rest;
            }
        }
        if (c) {
            auto [rest, mn] = split_leftmost(c);
            if (mn->lo == hi && mn->value == v) {
                hi = mn->hi;
                c = rest;
            }
        }
        return merge(a, merge(make(lo, hi, v), c));
    }

    tree add(const tree& root, std::int64_t lo, std::int64_t hi,
             const T& delta) {
        auto [a, bc] = split_at(root, lo);
        auto [b, c] = split_at(bc, hi);
        std::vector<segment<T>> segs;
        collect(b, segs);
        for (auto& s : segs) s.value = s.value + delta;
        // Coalesce equal-valued neighbours inside the touched range.
        std::vector<segment<T>> fused;
        for (const auto& s : segs) {
            if (!fused.empty() && fused.back().hi == s.lo &&
                fused.back().value == s.value)
                fused.back().hi = s.hi;
            else
                fused.push_back(s);
        }
        // Coalesce with adjacent neighbours outside the range.
        if (a && !fused.empty()) {
            auto [rest, mx] = split_rightmost(a);
            if (mx->hi == fused.front().lo && mx->value == fused.front().value) {
                fused.front().lo = mx->lo;
                a = rest;
            }
        }
        if (c && !fused.empty()) {
            auto [rest, mn] = split_leftmost(c);
            if (mn->lo == fused.back().hi && mn->value == fused.back().value) {
                fused.back().hi = mn->hi;
                c = rest;
            }
        }
        tree mid;
        for (const auto& s : fused) mid = merge(mid, make(s.lo, s.hi, s.value));
        return merge(a, merge(mid, c));
    }

private:
    NodeAlloc alloc_;
};

}  // namespace detail

// An ordered list of assign/add operations, applied in order of insertion.
template <typename T>
class batch {
public:
    batch& assign(std::int64_t lo, std::int64_t hi, T v) {
        ops_.push_back(op{true, lo, hi, std::move(v)});
        return *this;
    }
    batch& add(std::int64_t lo, std::int64_t hi, T delta) {
        ops_.push_back(op{false, lo, hi, std::move(delta)});
        return *this;
    }
    std::size_t size() const { return ops_.size(); }
    bool empty() const { return ops_.empty(); }

private:
    struct op {
        bool is_assign;
        std::int64_t lo;
        std::int64_t hi;
        T value;
    };
    std::vector<op> ops_;

    template <typename, typename>
    friend class index;
};

// The index itself.  One writer thread may call apply/assign/add; any
// number of reader threads may call snap()/query() concurrently.
template <typename T,
          typename Alloc = std::allocator<detail::node<T>>>
class index {
public:
    using value_type = T;
    using segment_type = segment<T>;

private:
    using core_type = detail::core<
        T, typename std::allocator_traits<Alloc>::template
               rebind_alloc<detail::node<T>>>;

public:

    // An immutable, independently keepable view of one published version.
    class snapshot {
    public:
        snapshot() = default;

        std::optional<T> query(std::int64_t x) const {
            const auto* n = core_type::find(root_, x);
            if (!n) return std::nullopt;
            return n->value;
        }

        // All segments, ordered by start.  Adjacent segments never carry
        // equal values (the index coalesces on every update).
        std::vector<segment_type> segments() const {
            std::vector<segment_type> out;
            core_type::collect(root_, out);
            return out;
        }

        bool empty() const { return !root_; }

    private:
        friend class index;
        explicit snapshot(typename core_type::tree root)
            : root_(std::move(root)) {}
        typename core_type::tree root_;
    };

    index() : index(Alloc{}) {}
    explicit index(Alloc alloc)
        : core_(typename std::allocator_traits<Alloc>::template
                rebind_alloc<detail::node<T>>(std::move(alloc))) {}

    index(const index&) = delete;
    index& operator=(const index&) = delete;

    // --- reader side (any thread) ---

    snapshot snap() const { return snapshot(root_.load()); }

    std::optional<T> query(std::int64_t x) const { return snap().query(x); }

    // --- writer side (single thread only) ---

    // Applies every op of the batch in order, then publishes the result
    // with one atomic store.
    void apply(const batch<T>& b) {
        typename core_type::tree root = root_.load(std::memory_order_relaxed);
        for (const auto& o : b.ops_) {
            if (o.lo >= o.hi) continue;  // empty ranges are no-ops
            if (o.is_assign)
                root = core_.assign(root, o.lo, o.hi, o.value);
            else
                root = core_.add(root, o.lo, o.hi, o.value);
        }
        root_.store(std::move(root));  // atomic publication
    }

    void assign(std::int64_t lo, std::int64_t hi, const T& v) {
        apply(batch<T>().assign(lo, hi, v));
    }

    void add(std::int64_t lo, std::int64_t hi, const T& delta) {
        apply(batch<T>().add(lo, hi, delta));
    }

private:
    core_type core_;
    std::atomic<typename core_type::tree> root_{};
};

}  // namespace interval_index
