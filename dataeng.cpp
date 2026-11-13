#include "dataeng.hpp"

#include <utility>

namespace dataeng {

namespace {

Timestamp saturating_add(Timestamp value, Duration delta) {
    if (delta > 0 && value > std::numeric_limits<Timestamp>::max() - delta) {
        return std::numeric_limits<Timestamp>::max();
    }
    if (delta < 0 && value < std::numeric_limits<Timestamp>::min() - delta) {
        return std::numeric_limits<Timestamp>::min();
    }
    return value + delta;
}

Timestamp saturating_sub(Timestamp value, Duration delta) {
    if (delta > 0 && value < std::numeric_limits<Timestamp>::min() + delta) {
        return std::numeric_limits<Timestamp>::min();
    }
    if (delta < 0 && value > std::numeric_limits<Timestamp>::max() + delta) {
        return std::numeric_limits<Timestamp>::max();
    }
    return value - delta;
}

}

IntervalJoin::IntervalJoin(Bounds bounds, Duration allowed_lateness)
    : bounds_(bounds), allowed_lateness_(allowed_lateness) {
    if (bounds_.lower > bounds_.upper) {
        throw std::invalid_argument("interval join lower bound must not exceed upper bound");
    }
    if (allowed_lateness_ < 0) {
        throw std::invalid_argument("allowed lateness must be non-negative");
    }
}

std::vector<Output> IntervalJoin::add_left(Event event) {
    if (finished_) {
        throw std::logic_error("interval join is already finished");
    }
    ++stats_.left_received;
    std::vector<Output> out;
    if (is_too_late(Side::Left, event.time)) {
        ++stats_.left_dropped_late;
        return out;
    }
    insert(Side::Left, std::move(event), out);
    process(Side::Left, out);
    return out;
}

std::vector<Output> IntervalJoin::add_right(Event event) {
    if (finished_) {
        throw std::logic_error("interval join is already finished");
    }
    ++stats_.right_received;
    std::vector<Output> out;
    if (is_too_late(Side::Right, event.time)) {
        ++stats_.right_dropped_late;
        return out;
    }
    insert(Side::Right, std::move(event), out);
    process(Side::Right, out);
    return out;
}

std::vector<Output> IntervalJoin::advance_watermark(Side side, Timestamp watermark) {
    if (finished_) {
        throw std::logic_error("interval join is already finished");
    }
    std::vector<Output> out;
    if (side == Side::Left) {
        if (watermark <= left_watermark_) {
            return out;
        }
        left_watermark_ = watermark;
        process(Side::Right, out);
    } else {
        if (watermark <= right_watermark_) {
            return out;
        }
        right_watermark_ = watermark;
        process(Side::Left, out);
    }
    return out;
}

std::vector<Output> IntervalJoin::finish() {
    std::vector<Output> out;
    if (finished_) {
        return out;
    }
    finished_ = true;

    for (Side side : {Side::Left, Side::Right}) {
        SideState& current = state(side);
        for (const auto& item : current.by_time) {
            for (const EntryPtr& entry : item.second) {
                if (!entry->outer_announced && entry->match_count == 0) {
                    emit_outer(side, entry, out);
                }
            }
        }
        current.by_time.clear();
        current.pending_outer.clear();
    }

    keys_.clear();
    stats_.live_left = 0;
    stats_.live_right = 0;
    left_watermark_ = std::numeric_limits<Timestamp>::max();
    right_watermark_ = std::numeric_limits<Timestamp>::max();
    return out;
}

Timestamp IntervalJoin::watermark(Side side) const {
    return side == Side::Left ? left_watermark_ : right_watermark_;
}

void IntervalJoin::insert(Side side, Event event, std::vector<Output>& out) {
    EntryPtr entry = std::make_shared<Entry>();
    entry->event = std::move(event);

    KeyState& key_state = keys_[entry->event.key];

    if (side == Side::Left) {
        Timestamp low = saturating_add(entry->event.time, bounds_.lower);
        Timestamp high = saturating_add(entry->event.time, bounds_.upper);
        auto it = key_state.right.lower_bound(low);
        while (it != key_state.right.end() && it->first <= high) {
            for (const EntryPtr& other : it->second) {
                if (other->outer_announced) {
                    out.push_back(Output{Change::Retract, RecordKind::RightOuter, std::nullopt, other->event});
                    other->outer_announced = false;
                }
                ++other->match_count;
                ++entry->match_count;
                out.push_back(Output{Change::Insert, RecordKind::Join, entry->event, other->event});
            }
            ++it;
        }
        key_state.left[entry->event.time].push_back(entry);
        left_state_.by_time[entry->event.time].push_back(entry);
        left_state_.pending_outer[entry->event.time].push_back(entry);
        ++stats_.live_left;
        return;
    }

    Timestamp low = saturating_sub(entry->event.time, bounds_.upper);
    Timestamp high = saturating_sub(entry->event.time, bounds_.lower);
    auto it = key_state.left.lower_bound(low);
    while (it != key_state.left.end() && it->first <= high) {
        for (const EntryPtr& other : it->second) {
            if (other->outer_announced) {
                out.push_back(Output{Change::Retract, RecordKind::LeftOuter, other->event, std::nullopt});
                other->outer_announced = false;
            }
            ++other->match_count;
            ++entry->match_count;
            out.push_back(Output{Change::Insert, RecordKind::Join, other->event, entry->event});
        }
        ++it;
    }
    key_state.right[entry->event.time].push_back(entry);
    right_state_.by_time[entry->event.time].push_back(entry);
    right_state_.pending_outer[entry->event.time].push_back(entry);
    ++stats_.live_right;
}

void IntervalJoin::process(Side target, std::vector<Output>& out) {
    SideState& current = state(target);
    Timestamp watermark_value =
        target == Side::Left ? right_watermark_ : left_watermark_;

    while (!current.pending_outer.empty()) {
        auto it = current.pending_outer.begin();
        if (!(outer_deadline(target, it->first) < watermark_value)) {
            break;
        }
        for (const EntryPtr& entry : it->second) {
            if (!entry->outer_announced && entry->match_count == 0) {
                emit_outer(target, entry, out);
            }
        }
        current.pending_outer.erase(it);
    }

    while (!current.by_time.empty()) {
        auto it = current.by_time.begin();
        if (!(eviction_deadline(target, it->first) < watermark_value)) {
            break;
        }
        Timestamp time = it->first;
        for (const EntryPtr& entry : it->second) {
            auto key_it = keys_.find(entry->event.key);
            if (key_it != keys_.end()) {
                KeyState& key_state = key_it->second;
                auto& ordered = target == Side::Left ? key_state.left : key_state.right;
                ordered.erase(time);
                if (key_state.left.empty() && key_state.right.empty()) {
                    keys_.erase(key_it);
                }
            }
            if (target == Side::Left) {
                --stats_.live_left;
            } else {
                --stats_.live_right;
            }
        }
        current.by_time.erase(it);
    }
}

void IntervalJoin::emit_outer(Side side, const EntryPtr& entry, std::vector<Output>& out) {
    if (side == Side::Left) {
        out.push_back(Output{Change::Insert, RecordKind::LeftOuter, entry->event, std::nullopt});
    } else {
        out.push_back(Output{Change::Insert, RecordKind::RightOuter, std::nullopt, entry->event});
    }
    entry->outer_announced = true;
}

bool IntervalJoin::is_too_late(Side side, Timestamp time) const {
    Timestamp threshold = saturating_sub(watermark(side), allowed_lateness_);
    return time < threshold;
}

Timestamp IntervalJoin::outer_deadline(Side target, Timestamp time) const {
    if (target == Side::Left) {
        return saturating_add(time, bounds_.upper);
    }
    return saturating_sub(time, bounds_.lower);
}

Timestamp IntervalJoin::eviction_deadline(Side target, Timestamp time) const {
    return saturating_add(outer_deadline(target, time), allowed_lateness_);
}

IntervalJoin::SideState& IntervalJoin::state(Side side) {
    return side == Side::Left ? left_state_ : right_state_;
}

const IntervalJoin::SideState& IntervalJoin::state(Side side) const {
    return side == Side::Left ? left_state_ : right_state_;
}

}
