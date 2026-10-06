#pragma once

// ManhattanPath: an ordered sequence of integer points (a polyline).
//
// Supports:
//   - insert / erase of points at any index (duplicates are legal),
//   - O(log n) expected range Manhattan-length queries: length(l, r) sums
//     |dx| + |dy| over consecutive pairs (i, i+1) with l <= i < r; the
//     connections outside [l, r] are NOT included,
//   - 64-bit overflow safety: any modification that would make the total
//     Manhattan length exceed int64_t is rejected and the path keeps its
//     old version (the operation is a no-op, reported by a false return).

#include <cstddef>
#include <cstdint>
#include <limits>
#include <random>
#include <stdexcept>
#include <utility>

namespace mpath {

struct Point {
    std::int64_t x = 0;
    std::int64_t y = 0;

    friend bool operator==(const Point&, const Point&) = default;
};

class ManhattanPath {
public:
    ManhattanPath() = default;
    ~ManhattanPath() { destroy(root_); }

    ManhattanPath(const ManhattanPath&) = delete;
    ManhattanPath& operator=(const ManhattanPath&) = delete;

    ManhattanPath(ManhattanPath&& other) noexcept
        : root_(std::exchange(other.root_, nullptr)), rng_(std::move(other.rng_)) {}

    ManhattanPath& operator=(ManhattanPath&& other) noexcept {
        if (this != &other) {
            destroy(root_);
            root_ = std::exchange(other.root_, nullptr);
            rng_ = std::move(other.rng_);
        }
        return *this;
    }

    std::size_t size() const { return root_ ? root_->size : 0; }
    bool empty() const { return root_ == nullptr; }

    // Total Manhattan length of the whole polyline (0 for fewer than 2 points).
    std::int64_t total_length() const { return root_ ? root_->sum : 0; }

    // Point at the given index.
    Point point_at(std::size_t index) const {
        if (index >= size()) throw std::out_of_range("ManhattanPath::point_at");
        const Node* node = root_;
        for (;;) {
            const std::size_t left_size = node->left ? node->left->size : 0;
            if (index < left_size) {
                node = node->left;
            } else if (index == left_size) {
                return node->point;
            } else {
                index -= left_size + 1;
                node = node->right;
            }
        }
    }

    // Inserts p so that it ends up at `index` (0..size()). Returns false and
    // leaves the path unchanged if the index is invalid or the resulting total
    // length would overflow int64_t.
    bool insert(std::size_t index, Point p) {
        const std::size_t n = size();
        if (index > n) return false;
        if (!fits_after_insert(index, p)) return false;

        Node* node = new Node{p, rng_()};
        Node *left, *right;
        split(root_, index, left, right);
        root_ = merge(merge(left, node), right);
        return true;
    }

    // Removes the point at `index`. Returns false and leaves the path
    // unchanged if the index is invalid or the resulting total length would
    // overflow int64_t (impossible by triangle inequality, checked anyway).
    bool erase(std::size_t index) {
        const std::size_t n = size();
        if (index >= n) return false;
        if (!fits_after_erase(index)) return false;

        Node *left, *mid, *right;
        split(root_, index, left, mid);
        split(mid, 1, mid, right);
        Node* victim = mid;
        root_ = merge(left, right);
        delete victim;
        return true;
    }

    // Manhattan length of the sub-polyline over points [l, r] (inclusive).
    // Only connections with both endpoints inside [l, r] are counted.
    std::int64_t length(std::size_t l, std::size_t r) const {
        if (l > r || r >= size()) throw std::out_of_range("ManhattanPath::length");
        return query(root_, 0, l, r).sum;
    }

private:
    struct Node {
        Point point;
        std::uint64_t priority;
        Node* left = nullptr;
        Node* right = nullptr;
        std::size_t size = 1;
        std::int64_t sum = 0;  // Manhattan length of edges inside the subtree
        Point first;           // in-order first point of the subtree
        Point last;            // in-order last point of the subtree

        Node(Point p, std::uint64_t prio)
            : point(p), priority(prio), first(p), last(p) {}
    };

    // Aggregate of a contiguous in-order range; `count == 0` means empty.
    struct Agg {
        std::size_t count = 0;
        std::int64_t sum = 0;
        Point first{};
        Point last{};
    };

    static __int128 dist(Point a, Point b) {
        __int128 dx = static_cast<__int128>(a.x) - b.x;
        __int128 dy = static_cast<__int128>(a.y) - b.y;
        if (dx < 0) dx = -dx;
        if (dy < 0) dy = -dy;
        return dx + dy;
    }

    static void pull(Node* t) {
        t->size = 1;
        t->sum = 0;
        t->first = t->last = t->point;
        if (t->left) {
            t->size += t->left->size;
            t->sum += t->left->sum + static_cast<std::int64_t>(dist(t->left->last, t->point));
            t->first = t->left->first;
        }
        if (t->right) {
            t->size += t->right->size;
            t->sum += t->right->sum + static_cast<std::int64_t>(dist(t->point, t->right->first));
            t->last = t->right->last;
        }
    }

    static void split(Node* t, std::size_t k, Node*& left, Node*& right) {
        if (!t) {
            left = right = nullptr;
            return;
        }
        const std::size_t left_size = t->left ? t->left->size : 0;
        if (k <= left_size) {
            split(t->left, k, left, t->left);
            right = t;
        } else {
            split(t->right, k - left_size - 1, t->right, right);
            left = t;
        }
        pull(t);
    }

    static Node* merge(Node* left, Node* right) {
        if (!left) return right;
        if (!right) return left;
        if (left->priority < right->priority) {
            left->right = merge(left->right, right);
            pull(left);
            return left;
        }
        right->left = merge(left, right->left);
        pull(right);
        return right;
    }

    static Agg combine(const Agg& a, const Agg& b) {
        if (a.count == 0) return b;
        if (b.count == 0) return a;
        Agg out;
        out.count = a.count + b.count;
        out.sum = a.sum + b.sum + static_cast<std::int64_t>(dist(a.last, b.first));
        out.first = a.first;
        out.last = b.last;
        return out;
    }

    // Aggregate of nodes whose in-order positions fall in [l, r]; `base` is
    // the in-order position of the leftmost node of subtree t.
    static Agg query(const Node* t, std::size_t base, std::size_t l, std::size_t r) {
        if (!t) return {};
        const std::size_t lo = base;
        const std::size_t hi = base + t->size - 1;
        if (r < lo || hi < l) return {};
        if (l <= lo && hi <= r) return Agg{t->size, t->sum, t->first, t->last};

        const std::size_t left_size = t->left ? t->left->size : 0;
        const std::size_t mid = base + left_size;
        Agg out = query(t->left, base, l, r);
        if (l <= mid && mid <= r) out = combine(out, Agg{1, 0, t->point, t->point});
        out = combine(out, query(t->right, mid + 1, l, r));
        return out;
    }

    static void destroy(Node* t) {
        if (!t) return;
        destroy(t->left);
        destroy(t->right);
        delete t;
    }

    static bool fits(__int128 new_total) {
        return new_total <= std::numeric_limits<std::int64_t>::max();
    }

    bool fits_after_insert(std::size_t index, Point p) const {
        __int128 total = total_length();
        const bool has_left = index > 0;
        const bool has_right = index < size();
        Point left, right;
        if (has_left) left = point_at(index - 1);
        if (has_right) right = point_at(index);
        if (has_left && has_right) total -= dist(left, right);
        if (has_left) total += dist(left, p);
        if (has_right) total += dist(p, right);
        return fits(total);
    }

    bool fits_after_erase(std::size_t index) const {
        __int128 total = total_length();
        const bool has_left = index > 0;
        const bool has_right = index + 1 < size();
        const Point mid = point_at(index);
        Point left, right;
        if (has_left) left = point_at(index - 1);
        if (has_right) right = point_at(index + 1);
        if (has_left) total -= dist(left, mid);
        if (has_right) total -= dist(mid, right);
        if (has_left && has_right) total += dist(left, right);
        return fits(total);
    }

    Node* root_ = nullptr;
    std::mt19937_64 rng_{std::random_device{}()};
};

}  // namespace mpath
