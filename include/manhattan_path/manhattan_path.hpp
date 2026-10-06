#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <random>
#include <stdexcept>
#include <utility>

namespace manhattan_path {

struct Point {
    std::int64_t x = 0;
    std::int64_t y = 0;

    friend bool operator==(const Point&, const Point&) = default;
};

inline __int128 dist128(const Point& a, const Point& b) {
    const __int128 dx = static_cast<__int128>(a.x) - static_cast<__int128>(b.x);
    const __int128 dy = static_cast<__int128>(a.y) - static_cast<__int128>(b.y);
    return (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
}

class Path {
public:
    Path() = default;

    Path(const Path&) = delete;
    Path& operator=(const Path&) = delete;

    Path(Path&& other) noexcept
        : root_(std::exchange(other.root_, nullptr)),
          total_(std::exchange(other.total_, 0)),
          rng_(std::move(other.rng_)) {}

    Path& operator=(Path&& other) noexcept {
        if (this != &other) {
            destroy(root_);
            root_ = std::exchange(other.root_, nullptr);
            total_ = std::exchange(other.total_, 0);
            rng_ = std::move(other.rng_);
        }
        return *this;
    }

    ~Path() { destroy(root_); }

    std::size_t size() const { return size(root_); }
    bool empty() const { return root_ == nullptr; }

    std::int64_t total_length() const { return total_; }

    Point at(std::size_t index) const {
        const Node* node = root_;
        while (node != nullptr) {
            const std::size_t left_size = size(node->left);
            if (index < left_size) {
                node = node->left;
            } else if (index == left_size) {
                return node->point;
            } else {
                index -= left_size + 1;
                node = node->right;
            }
        }
        throw std::out_of_range("Path::at");
    }

    // Inserts p at position index (0..size()). Returns false without
    // modifying the path if the index is invalid or the resulting total
    // Manhattan length would not fit in int64_t.
    bool insert(std::size_t index, const Point& p) {
        const std::size_t n = size();
        if (index > n) return false;

        __int128 new_total = total_;
        if (n > 0) {
            if (index == 0) {
                new_total += dist128(p, front());
            } else if (index == n) {
                new_total += dist128(back(), p);
            } else {
                const Point prev = at(index - 1);
                const Point next = at(index);
                new_total += dist128(prev, p) + dist128(p, next) - dist128(prev, next);
            }
        }
        if (new_total > std::numeric_limits<std::int64_t>::max()) return false;

        Node* left = nullptr;
        Node* right = nullptr;
        split(root_, index, left, right);
        Node* node = new Node(p, rng_());
        root_ = merge(merge(left, node), right);
        total_ = static_cast<std::int64_t>(new_total);
        return true;
    }

    // Erases the point at index. Never overflows (length only shrinks).
    // Returns false without modifying the path if the index is invalid.
    bool erase(std::size_t index) {
        const std::size_t n = size();
        if (index >= n) return false;

        __int128 new_total = 0;
        if (n > 1) {
            new_total = total_;
            if (index == 0) {
                new_total -= dist128(at(0), at(1));
            } else if (index == n - 1) {
                new_total -= dist128(at(n - 2), at(n - 1));
            } else {
                const Point prev = at(index - 1);
                const Point cur = at(index);
                const Point next = at(index + 1);
                new_total += dist128(prev, next) - dist128(prev, cur) - dist128(cur, next);
            }
        }

        Node* left = nullptr;
        Node* mid = nullptr;
        Node* right = nullptr;
        split(root_, index, left, mid);
        split(mid, 1, mid, right);
        destroy(mid);
        root_ = merge(left, right);
        total_ = static_cast<std::int64_t>(new_total);
        return true;
    }

    // Sum of Manhattan lengths of edges between points first..last,
    // excluding any connections to points outside the range.
    std::int64_t length(std::size_t first, std::size_t last) const {
        if (first > last || last >= size()) throw std::out_of_range("Path::length");
        return range_sum(root_, first, last, 0);
    }

    Point front() const { return root_ ? root_->first_point : throw std::out_of_range("Path::front"); }
    Point back() const { return root_ ? root_->last_point : throw std::out_of_range("Path::back"); }

private:
    struct Node {
        Point point;
        std::uint64_t priority;
        Node* left = nullptr;
        Node* right = nullptr;
        std::size_t subtree_size = 1;
        std::int64_t edge_sum = 0;
        Point first_point;
        Point last_point;

        Node(const Point& p, std::uint64_t prio)
            : point(p), priority(prio), first_point(p), last_point(p) {}
    };

    static std::size_t size(const Node* node) { return node ? node->subtree_size : 0; }

    static std::int64_t edge_sum(const Node* node) { return node ? node->edge_sum : 0; }

    static std::int64_t dist64(const Point& a, const Point& b) {
        return static_cast<std::int64_t>(dist128(a, b));
    }

    static void pull(Node* node) {
        if (!node) return;
        node->subtree_size = 1 + size(node->left) + size(node->right);
        node->edge_sum = edge_sum(node->left) + edge_sum(node->right);
        if (node->left) node->edge_sum += dist64(node->left->last_point, node->point);
        if (node->right) node->edge_sum += dist64(node->point, node->right->first_point);
        node->first_point = node->left ? node->left->first_point : node->point;
        node->last_point = node->right ? node->right->last_point : node->point;
    }

    static void split(Node* node, std::size_t count, Node*& left, Node*& right) {
        if (!node) {
            left = right = nullptr;
            return;
        }
        if (size(node->left) >= count) {
            split(node->left, count, left, node->left);
            right = node;
        } else {
            split(node->right, count - size(node->left) - 1, node->right, right);
            left = node;
        }
        pull(node);
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

    static std::int64_t range_sum(const Node* node, std::size_t first, std::size_t last,
                                  std::size_t base) {
        if (!node) return 0;
        const std::size_t lo = base;
        const std::size_t hi = base + node->subtree_size - 1;
        if (first <= lo && hi <= last) return node->edge_sum;

        const std::size_t self = base + size(node->left);
        std::int64_t result = 0;
        if (node->left && first < self && last >= lo)
            result += range_sum(node->left, first, last, lo);
        if (node->right && last > self) result += range_sum(node->right, first, last, self + 1);
        if (node->left && first <= self - 1 && self <= last)
            result += dist64(node->left->last_point, node->point);
        if (node->right && first <= self && self + 1 <= last)
            result += dist64(node->point, node->right->first_point);
        return result;
    }

    static void destroy(Node* node) {
        if (!node) return;
        destroy(node->left);
        destroy(node->right);
        delete node;
    }

    Node* root_ = nullptr;
    std::int64_t total_ = 0;
    std::mt19937_64 rng_{0x9E3779B97F4A7C15ULL};
};

}  // namespace manhattan_path
