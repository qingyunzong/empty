#include <cassert>
#include <chrono>

#include "dataeng.hpp"

using dataeng::ObserveState;
using Verdict = ObserveState::Verdict;
using namespace std::chrono_literals;

namespace {

constexpr ObserveState::Token kToken = 0xA5A5;

ObserveState::Notification notif(std::uint32_t seq, std::uint16_t mid,
                                 bool con = false,
                                 std::chrono::seconds max_age = 0s,
                                 ObserveState::Token token = kToken) {
    ObserveState::Notification n;
    n.token = token;
    n.sequence = seq;
    n.message_id = mid;
    n.confirmable = con;
    n.max_age = max_age;
    return n;
}

void test_half_range_rule() {
    using dataeng::kSequenceMask;
    assert(dataeng::sequence_precedes(1, 2));
    assert(!dataeng::sequence_precedes(2, 1));
    assert(!dataeng::sequence_precedes(5, 5));
    // Wrap-around: 0xFFFFFE precedes 3.
    assert(dataeng::sequence_precedes(kSequenceMask - 1, 3));
    assert(!dataeng::sequence_precedes(3, kSequenceMask - 1));
    // Exactly half range apart: neither precedes the other.
    assert(!dataeng::sequence_precedes(0, dataeng::kSequenceHalfRange));
    assert(!dataeng::sequence_precedes(dataeng::kSequenceHalfRange, 0));
    // Inputs are masked to 24 bits.
    assert(dataeng::sequence_precedes((1u << 24) | 7u, 9));
}

void test_basic_ordering() {
    ObserveState s;
    const auto t0 = ObserveState::Clock::now();
    s.reregister(kToken, t0);

    assert(s.on_notification(notif(10, 1), t0 + 1s) == Verdict::kDeliver);
    assert(s.last_sequence() == 10);
    assert(s.on_notification(notif(11, 2), t0 + 2s) == Verdict::kDeliver);
    // Older sequence inside the window is stale.
    assert(s.on_notification(notif(10, 3), t0 + 3s) == Verdict::kStale);
    // Same sequence with a new MID is a duplicate.
    assert(s.on_notification(notif(11, 4), t0 + 4s) == Verdict::kDuplicate);
    // Wrap-around across 2^24 is newer.
    ObserveState w;
    w.reregister(kToken, t0);
    assert(w.on_notification(notif(dataeng::kSequenceMask, 1), t0 + 1s) ==
           Verdict::kDeliver);
}

void test_confirmable_retransmission() {
    ObserveState s;
    const auto t0 = ObserveState::Clock::now();
    s.reregister(kToken, t0);

    assert(s.on_notification(notif(20, 100, /*con=*/true), t0 + 1s) ==
           Verdict::kDeliver);
    // Retransmission keeps the same message id: delivered only once.
    assert(s.on_notification(notif(20, 100, /*con=*/true), t0 + 2s) ==
           Verdict::kDuplicate);
    // A fresh confirmable with a new MID is delivered.
    assert(s.on_notification(notif(21, 101, /*con=*/true), t0 + 3s) ==
           Verdict::kDeliver);
}

void test_reregister_epoch() {
    ObserveState s;
    const auto t0 = ObserveState::Clock::now();
    s.reregister(kToken, t0);
    assert(s.epoch() == 1);
    assert(s.on_notification(notif(500, 1), t0 + 1s) == Verdict::kDeliver);

    s.reregister(kToken + 1, t0 + 2s);
    assert(s.epoch() == 2);
    // Late packet from the previous registration is rejected.
    assert(s.on_notification(notif(501, 2, false, 0s, kToken), t0 + 3s) ==
           Verdict::kWrongEpoch);
    // New epoch starts sequence tracking from scratch.
    assert(s.on_notification(notif(3, 3, false, 0s, kToken + 1), t0 + 4s) ==
           Verdict::kDeliver);
    assert(s.last_sequence() == 3);
}

void test_sleep_requires_resync() {
    ObserveState s;
    const auto t0 = ObserveState::Clock::now();
    s.reregister(kToken, t0);
    assert(s.on_notification(notif(7, 1), t0 + 1s) == Verdict::kDeliver);

    // Gap beyond the 128 s window: do not guess, demand resync.
    assert(s.on_notification(notif(8, 2), t0 + 200s) ==
           Verdict::kResyncRequired);
    // State is untouched by the refused notification.
    assert(s.last_sequence() == 7);

    // Re-registration recovers the observation.
    s.reregister(kToken + 9, t0 + 201s);
    assert(s.on_notification(notif(8, 3, false, 0s, kToken + 9), t0 + 202s) ==
           Verdict::kDeliver);
}

void test_max_age_freshness() {
    ObserveState s;
    const auto t0 = ObserveState::Clock::now();
    s.reregister(kToken, t0);
    assert(!s.fresh(t0));

    assert(s.on_notification(notif(1, 1, false, 30s), t0) ==
           Verdict::kDeliver);
    assert(s.fresh(t0 + 29s));
    assert(!s.fresh(t0 + 31s));

    // Absent Max-Age option falls back to the configured default (60 s).
    assert(s.on_notification(notif(2, 2), t0 + 32s) == Verdict::kDeliver);
    assert(s.fresh(t0 + 32s + 59s));
    assert(!s.fresh(t0 + 32s + 61s));
}

}  // namespace

int main() {
    test_half_range_rule();
    test_basic_ordering();
    test_confirmable_retransmission();
    test_reregister_epoch();
    test_sleep_requires_resync();
    test_max_age_freshness();
    return 0;
}
