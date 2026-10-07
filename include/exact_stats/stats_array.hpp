#pragma once

#include "exact_stats/bigint.hpp"
#include "exact_stats/rational.hpp"

#include <cstddef>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

namespace exact_stats {

// Integer array with range-add updates, exact mean/variance queries and
// cheap copy-on-write snapshots. Snapshots are fully independent branches:
// mutating one never affects any other.
class StatsArray {
public:
    explicit StatsArray(std::size_t n)
        : state_(std::make_shared<State>(State{std::vector<BigInt>(n)})) {}

    static StatsArray from_values(std::vector<BigInt> values) {
        StatsArray a(0);
        a.state_->values = std::move(values);
        return a;
    }

    // O(1); the underlying storage is shared and cloned lazily on write.
    StatsArray snapshot() const { return StatsArray(state_); }

    std::size_t size() const { return state_->values.size(); }

    const BigInt& at(std::size_t i) const {
        if (i >= size()) throw std::out_of_range("StatsArray::at");
        return state_->values[i];
    }

    void set(std::size_t i, BigInt value) {
        if (i >= size()) throw std::out_of_range("StatsArray::set");
        mutable_state().values[i] = std::move(value);
    }

    // Adds delta to every element in [l, r).
    void range_add(std::size_t l, std::size_t r, const BigInt& delta) {
        check_range(l, r);
        if (delta.is_zero()) return;
        State& s = mutable_state();
        for (std::size_t i = l; i < r; ++i) s.values[i] += delta;
    }

    BigInt range_sum(std::size_t l, std::size_t r) const {
        check_range(l, r);
        BigInt s;
        for (std::size_t i = l; i < r; ++i) s += state_->values[i];
        return s;
    }

    BigInt range_sumsq(std::size_t l, std::size_t r) const {
        check_range(l, r);
        BigInt q;
        for (std::size_t i = l; i < r; ++i) q += state_->values[i] * state_->values[i];
        return q;
    }

    // Exact mean: (Σx) / n as a reduced rational.
    Rational mean(std::size_t l, std::size_t r) const {
        check_range(l, r);
        if (l == r) throw std::domain_error("mean of empty range");
        return mean_of(range_sum(l, r), BigInt::from_u64(static_cast<unsigned long long>(r - l)));
    }

    // Exact population variance with no floating point anywhere:
    //   var = Σx²/n − (Σx/n)² = (n·Σx² − (Σx)²) / n²
    Rational variance(std::size_t l, std::size_t r) const {
        check_range(l, r);
        if (l == r) throw std::domain_error("variance of empty range");
        BigInt n = BigInt::from_u64(static_cast<unsigned long long>(r - l));
        BigInt sum = range_sum(l, r);
        BigInt sumsq = range_sumsq(l, r);
        return variance_of(sum, sumsq, n);
    }

    BigInt sum() const { return range_sum(0, size()); }
    BigInt sumsq() const { return range_sumsq(0, size()); }
    Rational mean() const { return mean(0, size()); }
    Rational variance() const { return variance(0, size()); }

    // Exact statistics from pre-aggregated moments. Counts (and moments)
    // may exceed 64 bits, e.g. when merging statistics across shards.
    static Rational mean_of(const BigInt& sum, const BigInt& count) {
        if (count.is_zero() || count.is_negative())
            throw std::domain_error("mean_of: count must be positive");
        return Rational(sum, count);
    }
    static Rational variance_of(const BigInt& sum, const BigInt& sumsq,
                                const BigInt& count) {
        if (count.is_zero() || count.is_negative())
            throw std::domain_error("variance_of: count must be positive");
        return Rational(count * sumsq - sum * sum, count * count);
    }

private:
    struct State {
        std::vector<BigInt> values;
    };

    explicit StatsArray(std::shared_ptr<State> state) : state_(std::move(state)) {}

    State& mutable_state() {
        if (!state_.unique()) state_ = std::make_shared<State>(*state_);
        return *state_;
    }

    void check_range(std::size_t l, std::size_t r) const {
        if (l > r || r > size()) throw std::out_of_range("StatsArray range");
    }

    std::shared_ptr<State> state_;
};

} // namespace exact_stats
