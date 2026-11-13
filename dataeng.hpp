#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>

namespace dataeng {

// CoAP Observe (RFC 7641) client-side notification ordering state,
// designed for constrained/embedded collectors.
//
// - 24-bit sequence numbers with the half-range comparison rule.
// - Arrival-time and Max-Age based freshness checks.
// - Re-registration opens a new epoch; late packets carrying a stale
//   token are rejected.
// - Confirmable retransmissions (same message id) are delivered once.
// - If the local clock gap exceeds the sequence window (e.g. after
//   sleep), the component refuses to guess and asks for a resync.

// 24-bit Observe sequence arithmetic (RFC 7641 section 3.4).
inline constexpr std::uint32_t kSequenceModulus = 1u << 24;
inline constexpr std::uint32_t kSequenceHalfRange = 1u << 23;
inline constexpr std::uint32_t kSequenceMask = kSequenceModulus - 1;

// True if `a` precedes `b` under the half-range rule.
bool sequence_precedes(std::uint32_t a, std::uint32_t b);

class ObserveState {
public:
    using Clock = std::chrono::steady_clock;
    using TimePoint = Clock::time_point;
    using Token = std::uint64_t;

    struct Config {
        std::chrono::seconds sequence_window{128};  // RFC 7641 time bound
        std::chrono::seconds default_max_age{60};   // RFC 7252 default
        std::size_t dedup_capacity{8};              // remembered confirmable MIDs
    };

    struct Notification {
        Token token{};
        std::uint32_t sequence{};  // low 24 bits are used
        std::uint16_t message_id{};
        bool confirmable{false};
        // Zero or negative means "option absent": default_max_age applies.
        std::chrono::seconds max_age{0};
    };

    enum class Verdict {
        kDeliver,         // fresh notification, deliver to application
        kDuplicate,       // retransmission or repeated sequence, drop
        kStale,           // older sequence inside the window, drop
        kWrongEpoch,      // token of a previous registration, drop
        kResyncRequired,  // timing gap too large; re-register, do not guess
    };

    ObserveState();
    explicit ObserveState(Config config);

    // Opens a new registration epoch. Sequence, message-id dedup and
    // freshness state from the previous epoch are invalidated.
    void reregister(Token token, TimePoint now);

    // Classifies an incoming notification; updates state when accepted.
    Verdict on_notification(const Notification& n, TimePoint now);

    // True while the last accepted notification is within its Max-Age.
    bool fresh(TimePoint now) const;

    bool registered() const { return registered_; }
    std::uint64_t epoch() const { return epoch_; }
    std::uint32_t last_sequence() const { return last_sequence_; }

private:
    Verdict accept(const Notification& n, std::uint32_t seq, TimePoint now);
    bool seen_message_id(std::uint16_t mid) const;
    void remember_message_id(std::uint16_t mid);

    Config config_;
    Token token_{};
    std::uint64_t epoch_{0};
    bool registered_{false};
    bool has_sequence_{false};
    std::uint32_t last_sequence_{0};
    TimePoint last_time_{};
    std::chrono::seconds last_max_age_{0};
    std::deque<std::uint16_t> recent_mids_;
};

}  // namespace dataeng
