#include "counter_set.hpp"

#include <stdexcept>

CounterSet::CounterSet(std::size_t n)
    : n_(n), mn_(4 * (n + 1), 0), lazy_(4 * (n + 1), 0) {}

void CounterSet::push(std::size_t node) const {
    long long pending = lazy_[node];
    if (pending == 0) return;
    mn_[2 * node] += pending;
    lazy_[2 * node] += pending;
    mn_[2 * node + 1] += pending;
    lazy_[2 * node + 1] += pending;
    lazy_[node] = 0;
}

long long CounterSet::rangeMin(std::size_t node, std::size_t lo, std::size_t hi,
                               std::size_t ql, std::size_t qr) const {
    if (ql <= lo && hi <= qr) return mn_[node];
    push(node);
    std::size_t mid = lo + (hi - lo) / 2;
    long long result = mn_[2 * node];  // overwritten below; safe init
    if (qr <= mid) {
        result = rangeMin(2 * node, lo, mid, ql, qr);
    } else if (ql > mid) {
        result = rangeMin(2 * node + 1, mid + 1, hi, ql, qr);
    } else {
        long long left = rangeMin(2 * node, lo, mid, ql, qr);
        long long right = rangeMin(2 * node + 1, mid + 1, hi, ql, qr);
        result = left < right ? left : right;
    }
    return result;
}

void CounterSet::apply(std::size_t node, std::size_t lo, std::size_t hi,
                       std::size_t ql, std::size_t qr, long long delta) const {
    if (ql <= lo && hi <= qr) {
        mn_[node] += delta;
        lazy_[node] += delta;
        return;
    }
    push(node);
    std::size_t mid = lo + (hi - lo) / 2;
    if (ql <= mid) apply(2 * node, lo, mid, ql, qr, delta);
    if (qr > mid) apply(2 * node + 1, mid + 1, hi, ql, qr, delta);
    mn_[node] = mn_[2 * node] < mn_[2 * node + 1] ? mn_[2 * node] : mn_[2 * node + 1];
}

bool CounterSet::add(std::size_t lo, std::size_t hi, long long delta) {
    if (lo > hi || hi > n_) throw std::out_of_range("CounterSet::add range");
    if (delta == 0) return true;
    if (delta < 0 && rangeMin(1, 0, n_, lo, hi) < -delta) return false;
    apply(1, 0, n_, lo, hi, delta);
    return true;
}

std::size_t CounterSet::findZero(std::size_t node, std::size_t lo, std::size_t hi) const {
    if (lo == hi) return lo;
    push(node);
    std::size_t mid = lo + (hi - lo) / 2;
    // Counts are never negative, so a child has a zero iff its minimum is 0.
    if (mn_[2 * node] == 0) return findZero(2 * node, lo, mid);
    return findZero(2 * node + 1, mid + 1, hi);
}

std::optional<std::size_t> CounterSet::firstZero() const {
    if (mn_[1] != 0) return std::nullopt;
    return findZero(1, 0, n_);
}

long long CounterSet::count(std::size_t index) const {
    if (index > n_) throw std::out_of_range("CounterSet::count index");
    std::size_t node = 1, lo = 0, hi = n_;
    while (lo != hi) {
        push(node);
        std::size_t mid = lo + (hi - lo) / 2;
        if (index <= mid) {
            node = 2 * node;
            hi = mid;
        } else {
            node = 2 * node + 1;
            lo = mid + 1;
        }
    }
    return mn_[node];
}
