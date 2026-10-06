#pragma once

#include "statlib/bigint.hpp"
#include "statlib/rational.hpp"

#include <cstddef>
#include <memory>
#include <utility>
#include <vector>

namespace statlib {

// Interval statistics over an array of arbitrary-precision integers.
//
//  * add(l, r, v): add integer v to every element in [l, r)
//  * sum / sumsq / mean / variance over any interval, all exact
//  * fork(): cheap O(1) snapshot branch
//
// Implemented as a persistent (path-copying) segment tree with lazy
// propagation. Nodes are immutable and shared between snapshots, so branches
// created by fork() never observe each other's updates. Aggregates keep
// exact sums and sums of squares as big integers; mean and variance are
// derived as exact rationals (variance = E[x^2] - E[x]^2, no floating point).
class StatsTree {
public:
    explicit StatsTree(std::vector<BigInt> values);

    // O(1) snapshot: the returned tree shares storage with this one but is
    // fully independent; updates on either never affect the other.
    StatsTree fork() const { return StatsTree(root_, n_); }

    // Adds v to every element in [l, r). 0 <= l <= r <= size().
    void add(std::size_t l, std::size_t r, const BigInt& v);

    std::size_t size() const { return n_; }

    BigInt sum(std::size_t l, std::size_t r) const;
    BigInt sumsq(std::size_t l, std::size_t r) const;
    Rational mean(std::size_t l, std::size_t r) const;
    // Population variance: E[x^2] - E[x]^2, exact.
    Rational variance(std::size_t l, std::size_t r) const;

private:
    struct Node {
        BigInt sum;    // sum of elements, excluding pending lazy of ancestors
        BigInt sumsq;  // sum of squares, excluding pending lazy of ancestors
        BigInt lazy;   // pending add not yet pushed to children
        std::shared_ptr<const Node> left;
        std::shared_ptr<const Node> right;
    };

    StatsTree(std::shared_ptr<const Node> root, std::size_t n) : root_(std::move(root)), n_(n) {}

    static std::shared_ptr<const Node> build(const std::vector<BigInt>& values,
                                             std::size_t l, std::size_t r);
    // Returns a new node with (x -> x + v) applied to all `len` covered elements.
    static std::shared_ptr<const Node> apply(const std::shared_ptr<const Node>& node,
                                             const BigInt& v, std::size_t len);
    static std::shared_ptr<const Node> update(const std::shared_ptr<const Node>& node,
                                              std::size_t l, std::size_t r,
                                              std::size_t ql, std::size_t qr,
                                              const BigInt& v);
    // Accumulates (sum, sumsq) over [ql, qr); `carry` holds lazy adds of ancestors.
    static std::pair<BigInt, BigInt> query(const std::shared_ptr<const Node>& node,
                                           std::size_t l, std::size_t r,
                                           std::size_t ql, std::size_t qr,
                                           const BigInt& carry);

    std::shared_ptr<const Node> root_;
    std::size_t n_;
};

}  // namespace statlib
