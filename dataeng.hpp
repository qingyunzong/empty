#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace dataeng {

using Timestamp = std::int64_t;
using Duration = std::int64_t;

enum class Side { Left, Right };

struct Event {
    std::string key;
    Timestamp time = 0;
    std::uint64_t id = 0;
    std::string payload;

    Event() = default;

    Event(std::string key_value, Timestamp time_value, std::uint64_t id_value = 0,
          std::string payload_value = {})
        : key(std::move(key_value)),
          time(time_value),
          id(id_value),
          payload(std::move(payload_value)) {}

    friend bool operator==(const Event&, const Event&) = default;
};

enum class Change { Insert, Retract };

enum class RecordKind { Join, LeftOuter, RightOuter };

struct Output {
    Change change = Change::Insert;
    RecordKind kind = RecordKind::Join;
    std::optional<Event> left;
    std::optional<Event> right;

    friend bool operator==(const Output&, const Output&) = default;
};

class IntervalJoin {
public:
    struct Bounds {
        Duration lower = 0;
        Duration upper = 0;

        static Bounds symmetric(Duration max_abs_difference) {
            if (max_abs_difference < 0) {
                throw std::invalid_argument("symmetric interval bound must be non-negative");
            }
            return Bounds{-max_abs_difference, max_abs_difference};
        }
    };

    struct Stats {
        std::uint64_t left_received = 0;
        std::uint64_t right_received = 0;
        std::uint64_t left_dropped_late = 0;
        std::uint64_t right_dropped_late = 0;
        std::uint64_t live_left = 0;
        std::uint64_t live_right = 0;
    };

    explicit IntervalJoin(Bounds bounds, Duration allowed_lateness = 0);

    std::vector<Output> add_left(Event event);
    std::vector<Output> add_right(Event event);
    std::vector<Output> advance_watermark(Side side, Timestamp watermark);
    std::vector<Output> finish();

    Timestamp watermark(Side side) const;
    bool finished() const { return finished_; }
    const Stats& stats() const { return stats_; }
    const Bounds& bounds() const { return bounds_; }
    Duration allowed_lateness() const { return allowed_lateness_; }

private:
    struct Entry {
        Event event;
        std::size_t match_count = 0;
        bool outer_announced = false;
    };

    using EntryPtr = std::shared_ptr<Entry>;

    struct KeyState {
        std::map<Timestamp, std::vector<EntryPtr>> left;
        std::map<Timestamp, std::vector<EntryPtr>> right;
    };

    struct SideState {
        std::map<Timestamp, std::vector<EntryPtr>> by_time;
        std::map<Timestamp, std::vector<EntryPtr>> pending_outer;
    };

    void insert(Side side, Event event, std::vector<Output>& out);
    void process(Side target, std::vector<Output>& out);
    void emit_outer(Side side, const EntryPtr& entry, std::vector<Output>& out);
    bool is_too_late(Side side, Timestamp time) const;
    Timestamp outer_deadline(Side target, Timestamp time) const;
    Timestamp eviction_deadline(Side target, Timestamp time) const;
    SideState& state(Side side);
    const SideState& state(Side side) const;

    Bounds bounds_;
    Duration allowed_lateness_;
    Timestamp left_watermark_ = std::numeric_limits<Timestamp>::min();
    Timestamp right_watermark_ = std::numeric_limits<Timestamp>::min();
    std::map<std::string, KeyState> keys_;
    SideState left_state_;
    SideState right_state_;
    Stats stats_;
    bool finished_ = false;
};

}
