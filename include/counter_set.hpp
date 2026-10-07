#pragma once

#include <cstddef>
#include <optional>
#include <vector>

// CounterSet maintains occurrence counts for integers 0..n (inclusive).
// All counts start at 0 and are never allowed to go negative:
// a range update that would make any count negative is rejected as a whole.
class CounterSet {
public:
    // Tracks integers 0..n inclusive (n + 1 slots).
    explicit CounterSet(std::size_t n);

    std::size_t maxValue() const { return n_; }

    // Adds delta (may be negative) to every count in [lo, hi].
    // Returns false and changes nothing if any resulting count would be negative.
    // Throws std::out_of_range if lo > hi or hi > n.
    bool add(std::size_t lo, std::size_t hi, long long delta);

    // Smallest integer in [0, n] whose count is 0, or std::nullopt if all full.
    [[nodiscard]] std::optional<std::size_t> firstZero() const;

    // Current count of a single value (for verification / debugging).
    [[nodiscard]] long long count(std::size_t index) const;

private:
    void push(std::size_t node) const;
    long long rangeMin(std::size_t node, std::size_t lo, std::size_t hi,
                       std::size_t ql, std::size_t qr) const;
    void apply(std::size_t node, std::size_t lo, std::size_t hi,
               std::size_t ql, std::size_t qr, long long delta) const;
    std::size_t findZero(std::size_t node, std::size_t lo, std::size_t hi) const;

    std::size_t n_;
    mutable std::vector<long long> mn_;    // segment tree minimum
    mutable std::vector<long long> lazy_;  // pending range add
};
