#pragma once

#include <cstddef>
#include <optional>
#include <vector>

// Maintains occurrence counts for integers 0..N (inclusive).
// Supports range add/subtract of counts and querying the smallest
// integer whose count is zero (the mex over the tracked domain).
// Any update that would drive a count negative is rejected as a whole.
class MexCounter {
public:
    explicit MexCounter(std::size_t n) : n_(n), size_(n + 1) {
        min_.assign(4 * size_, 0);
        lazy_.assign(4 * size_, 0);
    }

    std::size_t size() const { return size_; }

    // Adds delta (may be negative) to every count in [l, r].
    // Returns false and changes nothing if the range is invalid or any
    // resulting count would become negative.
    bool add(std::size_t l, std::size_t r, long long delta) {
        if (l > r || r > n_ || delta == 0) {
            return delta == 0 && l <= r && r <= n_;
        }
        if (delta < 0 && range_min(1, 0, n_, l, r) < -delta) {
            return false;
        }
        apply(1, 0, n_, l, r, delta);
        return true;
    }

    // Smallest i in [0, N] with count zero, or nullopt when all counts
    // are positive ("full").
    std::optional<std::size_t> first_zero() {
        if (min_[1] > 0) {
            return std::nullopt;
        }
        return find_zero(1, 0, n_);
    }

    // Current count of value i (point query).
    long long count_at(std::size_t i) const {
        return point_query(1, 0, n_, i);
    }

private:
    void push(std::size_t node) {
        long long v = lazy_[node];
        if (v == 0) {
            return;
        }
        for (std::size_t child : {2 * node, 2 * node + 1}) {
            min_[child] += v;
            lazy_[child] += v;
        }
        lazy_[node] = 0;
    }

    void apply(std::size_t node, std::size_t lo, std::size_t hi,
               std::size_t l, std::size_t r, long long delta) {
        if (l <= lo && hi <= r) {
            min_[node] += delta;
            lazy_[node] += delta;
            return;
        }
        push(node);
        std::size_t mid = lo + (hi - lo) / 2;
        if (l <= mid) {
            apply(2 * node, lo, mid, l, r, delta);
        }
        if (r > mid) {
            apply(2 * node + 1, mid + 1, hi, l, r, delta);
        }
        min_[node] = min_[2 * node] < min_[2 * node + 1]
                         ? min_[2 * node]
                         : min_[2 * node + 1];
    }

    long long range_min(std::size_t node, std::size_t lo, std::size_t hi,
                        std::size_t l, std::size_t r) const {
        if (l <= lo && hi <= r) {
            return min_[node];
        }
        // Lazy values only ever shift a whole subtree uniformly, so a
        // partially overlapping node's stored min plus nothing else is
        // not valid; descend instead. Const visit: no push, account for
        // the pending lazy of this node manually.
        long long pending = lazy_[node];
        std::size_t mid = lo + (hi - lo) / 2;
        long long best = -1;  // sentinel: counts stay non-negative
        if (l <= mid) {
            best = range_min(2 * node, lo, mid, l, r);
        }
        if (r > mid) {
            long long v = range_min(2 * node + 1, mid + 1, hi, l, r);
            if (best < 0 || v < best) {
                best = v;
            }
        }
        return best + pending;
    }

    std::size_t find_zero(std::size_t node, std::size_t lo, std::size_t hi) {
        if (lo == hi) {
            return lo;
        }
        push(node);
        std::size_t mid = lo + (hi - lo) / 2;
        if (min_[2 * node] == 0) {
            return find_zero(2 * node, lo, mid);
        }
        return find_zero(2 * node + 1, mid + 1, hi);
    }

    long long point_query(std::size_t node, std::size_t lo, std::size_t hi,
                          std::size_t i) const {
        if (lo == hi) {
            return min_[node];
        }
        long long pending = lazy_[node];
        std::size_t mid = lo + (hi - lo) / 2;
        if (i <= mid) {
            return pending + point_query(2 * node, lo, mid, i);
        }
        return pending + point_query(2 * node + 1, mid + 1, hi, i);
    }

    std::size_t n_;
    std::size_t size_;
    std::vector<long long> min_;
    std::vector<long long> lazy_;
};
