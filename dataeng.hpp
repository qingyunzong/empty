#pragma once

#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <stdexcept>
#include <vector>

namespace dataeng {

// Sentinel for the open end of a half-open interval.
template <typename Time>
struct time_traits {
    static constexpr Time infinity() noexcept {
        return std::numeric_limits<Time>::max();
    }
};

// One immutable bitemporal version of a key.
// All intervals are half-open: [from, to).
// value == nullopt means the record is a tombstone (delete marker).
template <typename Key, typename Value, typename Time = std::int64_t>
struct bitemporal_record {
    Key key;
    std::optional<Value> value;
    Time valid_from;
    Time valid_to;
    Time sys_from;
    Time sys_to;

    bool is_tombstone() const noexcept { return !value.has_value(); }
    bool is_current() const noexcept {
        return sys_to == time_traits<Time>::infinity();
    }
    bool visible_at(Time valid_at, Time sys_at) const noexcept {
        return valid_from <= valid_at && valid_at < valid_to &&
               sys_from <= sys_at && sys_at < sys_to;
    }
};

// Embeddable bitemporal state store.
//
// Invariants:
//  - Records are append-only; corrections close the current system
//    version (sys_to = now) and insert new records, never mutate values.
//  - For each key, at most one record is visible at any (valid, sys)
//    point, so as-of/as-at queries always return a unique set.
//  - All interval boundaries are half-open [from, to).
//
// The caller supplies the transaction (system) time; it should be
// monotonically non-decreasing across mutations.
template <typename Key, typename Value, typename Time = std::int64_t>
class bitemporal_store {
public:
    using record = bitemporal_record<Key, Value, Time>;
    static constexpr Time infinity = time_traits<Time>::infinity();

    // Insert or retroactively correct the value of `key` over the
    // half-open valid-time interval [valid_from, valid_to).
    // Overlapping current versions are closed at `sys_now`; their
    // non-overlapping remainders are re-inserted as new versions.
    const record& put(const Key& key, Value value, Time valid_from,
                      Time valid_to, Time sys_now) {
        return apply(key, std::optional<Value>(std::move(value)),
                     valid_from, valid_to, sys_now);
    }

    // Delete `key` over [valid_from, valid_to) by writing a tombstone.
    const record& erase(const Key& key, Time valid_from, Time valid_to,
                        Time sys_now) {
        return apply(key, std::nullopt, valid_from, valid_to, sys_now);
    }

    // Value of `key` as known at system time `sys_at`, effective at
    // valid time `valid_at`. nullopt if absent or tombstoned.
    std::optional<Value> as_of(const Key& key, Time valid_at,
                               Time sys_at) const {
        for (const auto& r : records_) {
            if (r.key == key && r.visible_at(valid_at, sys_at)) {
                return r.value;
            }
        }
        return std::nullopt;
    }

    // All live key/value pairs visible at (valid_at, sys_at).
    std::map<Key, Value> snapshot(Time valid_at, Time sys_at) const {
        std::map<Key, Value> out;
        for (const auto& r : records_) {
            if (r.value && r.visible_at(valid_at, sys_at)) {
                out.emplace(r.key, *r.value);
            }
        }
        return out;
    }

    // Every record visible at system time `sys_at` (the full valid-time
    // state as known then). Tombstones included iff requested.
    std::vector<record> as_at(Time sys_at,
                              bool include_tombstones = false) const {
        std::vector<record> out;
        for (const auto& r : records_) {
            if (r.sys_from <= sys_at && sys_at < r.sys_to &&
                (include_tombstones || r.value)) {
                out.push_back(r);
            }
        }
        return out;
    }

    // Full audit trail for one key, in insertion order.
    std::vector<record> history(const Key& key) const {
        std::vector<record> out;
        for (const auto& r : records_) {
            if (r.key == key) {
                out.push_back(r);
            }
        }
        return out;
    }

    const std::vector<record>& records() const noexcept { return records_; }
    std::size_t size() const noexcept { return records_.size(); }

private:
    const record& apply(const Key& key, std::optional<Value> value,
                        Time valid_from, Time valid_to, Time sys_now) {
        if (!(valid_from < valid_to)) {
            throw std::invalid_argument(
                "valid interval must be non-empty and half-open [from, to)");
        }
        if (!(sys_now < infinity)) {
            throw std::invalid_argument("sys_now must be < infinity");
        }

        // Close overlapping current versions and collect their
        // non-overlapping valid-time remainders.
        std::vector<record> remainders;
        for (auto& r : records_) {
            if (!(r.key == key) || r.sys_to != infinity) {
                continue;
            }
            if (r.valid_from < valid_to && valid_from < r.valid_to) {
                const Time old_from = r.valid_from;
                const Time old_to = r.valid_to;
                const auto old_value = r.value;
                r.sys_to = sys_now;  // close, history preserved
                if (old_from < valid_from) {
                    remainders.push_back(
                        {key, old_value, old_from, valid_from, sys_now,
                         infinity});
                }
                if (valid_to < old_to) {
                    remainders.push_back(
                        {key, old_value, valid_to, old_to, sys_now,
                         infinity});
                }
            }
        }
        for (auto& rem : remainders) {
            records_.push_back(std::move(rem));
        }
        records_.push_back(
            {key, std::move(value), valid_from, valid_to, sys_now, infinity});
        return records_.back();
    }

    std::vector<record> records_;
};

}  // namespace dataeng
