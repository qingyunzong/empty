#include "dataeng.hpp"

#include <algorithm>

namespace dataeng {

bool sequence_precedes(std::uint32_t a, std::uint32_t b) {
    a &= kSequenceMask;
    b &= kSequenceMask;
    return (a < b && b - a < kSequenceHalfRange) ||
           (a > b && a - b > kSequenceHalfRange);
}

ObserveState::ObserveState() : ObserveState(Config{}) {}

ObserveState::ObserveState(Config config) : config_(config) {}

void ObserveState::reregister(Token token, TimePoint now) {
    token_ = token;
    ++epoch_;
    registered_ = true;
    has_sequence_ = false;
    last_sequence_ = 0;
    last_time_ = now;
    last_max_age_ = config_.default_max_age;
    recent_mids_.clear();
}

ObserveState::Verdict ObserveState::on_notification(const Notification& n,
                                                    TimePoint now) {
    if (!registered_ || n.token != token_) {
        return Verdict::kWrongEpoch;
    }

    if (n.confirmable && seen_message_id(n.message_id)) {
        return Verdict::kDuplicate;
    }

    const std::uint32_t seq = n.sequence & kSequenceMask;

    if (!has_sequence_) {
        return accept(n, seq, now);
    }

    // A gap beyond the sequence window (typically after sleep) makes the
    // half-range comparison unreliable: refuse to guess, ask for resync.
    const auto elapsed = now - last_time_;
    if (elapsed > config_.sequence_window) {
        return Verdict::kResyncRequired;
    }

    if (sequence_precedes(last_sequence_, seq)) {
        return accept(n, seq, now);
    }
    if (seq == last_sequence_) {
        return Verdict::kDuplicate;
    }
    return Verdict::kStale;
}

bool ObserveState::fresh(TimePoint now) const {
    return has_sequence_ && now - last_time_ <= last_max_age_;
}

ObserveState::Verdict ObserveState::accept(const Notification& n,
                                           std::uint32_t seq,
                                           TimePoint now) {
    last_sequence_ = seq;
    last_time_ = now;
    has_sequence_ = true;
    last_max_age_ = n.max_age.count() > 0 ? n.max_age : config_.default_max_age;
    if (n.confirmable) {
        remember_message_id(n.message_id);
    }
    return Verdict::kDeliver;
}

bool ObserveState::seen_message_id(std::uint16_t mid) const {
    return std::find(recent_mids_.begin(), recent_mids_.end(), mid) !=
           recent_mids_.end();
}

void ObserveState::remember_message_id(std::uint16_t mid) {
    recent_mids_.push_back(mid);
    while (recent_mids_.size() > config_.dedup_capacity) {
        recent_mids_.pop_front();
    }
}

}  // namespace dataeng
