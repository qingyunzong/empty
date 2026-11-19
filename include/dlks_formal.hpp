#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace dlks_formal {

using timestamp_t = std::int64_t;
using sequence_t = std::uint64_t;

template <class Key = std::string, class Value = std::int64_t>
struct event {
    Key key{};
    timestamp_t timestamp{};
    Value value{};
    sequence_t sequence{};

    friend bool operator==(const event&, const event&) = default;
};

template <class Key = std::string, class Value = std::int64_t>
struct window_result {
    Key key{};
    timestamp_t start{};
    timestamp_t end{};
    std::vector<event<Key, Value>> members{};
    Value aggregate{};

    friend bool operator==(const window_result&, const window_result&) = default;
};

template <class Key = std::string, class Value = std::int64_t>
struct step_result {
    std::vector<window_result<Key, Value>> closed{};
    std::vector<event<Key, Value>> late{};

    friend bool operator==(const step_result&, const step_result&) = default;
};

// A header-only session-window state machine.
//
// Semantics:
//   * A session starts as [t, t] for an event at t. Two sessions merge when
//     the distance between the left end and the right start is <= gap.
//   * Watermark W accepts timestamps equal to W and rejects timestamps < W as
//     late. A session closes when W - session.end > gap. The strict comparison
//     is intentional: an event exactly on the watermark can still merge when
//     it is exactly gap away from the current end.
//   * Members are ordered by (timestamp, input sequence). Sequence numbers are
//     assigned by this state machine and are never supplied by the caller.
//   * Closed sessions are immutable. A late event is reported only through
//     step_result::late.
//   * Closed windows are returned by (end, start, key).
template <class Key = std::string, class Value = std::int64_t>
class session_window_state {
public:
    using event_type = event<Key, Value>;
    using window_type = window_result<Key, Value>;
    using result_type = step_result<Key, Value>;

    explicit session_window_state(timestamp_t gap = 0) : gap_(validated_gap(gap)) {}

    [[nodiscard]] timestamp_t gap() const noexcept { return gap_; }

    [[nodiscard]] std::optional<timestamp_t> watermark() const noexcept {
        return watermark_;
    }

    // Changes the gap and rebuilds the currently open sessions. Already closed
    // windows are immutable, so this cannot reopen or alter them.
    void set_gap(timestamp_t gap) {
        gap = validated_gap(gap);
        if (gap == gap_) {
            return;
        }
        gap_ = gap;

        for (auto& [key, sessions] : open_sessions_) {
            static_cast<void>(key);
            std::vector<event_type> members;
            for (auto& session : sessions) {
                for (auto& member : session.members) {
                    members.push_back(std::move(member));
                }
            }
            sessions = rebuild_sessions(std::move(members));
        }
    }

    // Ingests one event. The returned step contains a side output when the
    // event is earlier than the current watermark, and is otherwise empty.
    result_type process(const event_type& input) {
        result_type result;
        event_type accepted = input;
        accepted.sequence = next_sequence_++;

        if (watermark_ && accepted.timestamp < *watermark_) {
            result.late.push_back(std::move(accepted));
            return result;
        }

        auto& sessions = open_sessions_[accepted.key];
        auto position = std::lower_bound(
            sessions.begin(), sessions.end(), accepted.timestamp,
            [](const open_session& session, timestamp_t timestamp) {
                return session.start < timestamp;
            });

        open_session singleton{accepted.timestamp, accepted.timestamp, {}};
        singleton.members.push_back(std::move(accepted));
        sessions.insert(position, std::move(singleton));
        merge_adjacent(sessions);
        return result;
    }

    // Convenience overload for the common string-key, integer-value case.
    result_type process(const Key& key, timestamp_t timestamp, Value value) {
        return process(event_type{key, timestamp, std::move(value), 0});
    }

    // Watermarks must be monotonic. Repeating the current watermark is a no-op.
    // The returned step contains every session that became closed.
    result_type advance_watermark(timestamp_t watermark) {
        if (watermark_ && watermark < *watermark_) {
            throw std::invalid_argument("watermark must not move backwards");
        }

        result_type result;
        if (watermark_ && watermark == *watermark_) {
            return result;
        }
        watermark_ = watermark;

        for (auto key_it = open_sessions_.begin(); key_it != open_sessions_.end();) {
            auto& sessions = key_it->second;
            for (auto session_it = sessions.begin(); session_it != sessions.end();) {
                if (!is_closed(*session_it, watermark)) {
                    ++session_it;
                    continue;
                }
                result.closed.push_back(make_window(key_it->first, std::move(*session_it)));
                session_it = sessions.erase(session_it);
            }

            if (sessions.empty()) {
                key_it = open_sessions_.erase(key_it);
            } else {
                ++key_it;
            }
        }

        std::sort(result.closed.begin(), result.closed.end(), window_order);
        return result;
    }

    [[nodiscard]] std::size_t open_window_count() const noexcept {
        std::size_t count = 0;
        for (const auto& [key, sessions] : open_sessions_) {
            static_cast<void>(key);
            count += sessions.size();
        }
        return count;
    }

private:
    struct open_session {
        timestamp_t start{};
        timestamp_t end{};
        std::vector<event_type> members{};
    };

    static timestamp_t validated_gap(timestamp_t gap) {
        if (gap < 0) {
            throw std::invalid_argument("gap must be non-negative");
        }
        return gap;
    }

    static bool connected(timestamp_t left_end, timestamp_t right_start,
                          timestamp_t gap) noexcept {
        if (right_start <= left_end) {
            return true;
        }
        // Unsigned subtraction represents the full signed distance without
        // overflowing, including intervals spanning INT64_MIN and INT64_MAX.
        const auto distance = static_cast<std::uint64_t>(right_start) -
                              static_cast<std::uint64_t>(left_end);
        return distance <= static_cast<std::uint64_t>(gap);
    }

    bool is_closed(const open_session& session, timestamp_t watermark) const noexcept {
        if (watermark <= session.end) {
            return false;
        }
        const auto distance = static_cast<std::uint64_t>(watermark) -
                              static_cast<std::uint64_t>(session.end);
        return distance > static_cast<std::uint64_t>(gap_);
    }

    void merge_adjacent(std::vector<open_session>& sessions) const {
        std::vector<open_session> merged;
        merged.reserve(sessions.size());

        for (auto& session : sessions) {
            if (merged.empty() || !connected(merged.back().end, session.start, gap_)) {
                merged.push_back(std::move(session));
                continue;
            }

            auto& target = merged.back();
            target.start = std::min(target.start, session.start);
            target.end = std::max(target.end, session.end);
            target.members.insert(target.members.end(),
                                  std::make_move_iterator(session.members.begin()),
                                  std::make_move_iterator(session.members.end()));
        }
        sessions = std::move(merged);
    }

    std::vector<open_session> rebuild_sessions(std::vector<event_type> members) const {
        std::sort(members.begin(), members.end(), member_order);

        std::vector<open_session> sessions;
        for (auto& member : members) {
            if (sessions.empty() ||
                !connected(sessions.back().end, member.timestamp, gap_)) {
                sessions.push_back(open_session{member.timestamp, member.timestamp, {}});
            }
            sessions.back().end = member.timestamp;
            sessions.back().members.push_back(std::move(member));
        }
        return sessions;
    }

    static bool member_order(const event_type& left, const event_type& right) noexcept {
        if (left.timestamp != right.timestamp) {
            return left.timestamp < right.timestamp;
        }
        return left.sequence < right.sequence;
    }

    static window_type make_window(const Key& key, open_session session) {
        std::sort(session.members.begin(), session.members.end(), member_order);

        Value aggregate{};
        for (const auto& member : session.members) {
            aggregate = std::move(aggregate) + member.value;
        }

        return window_type{key, session.start, session.end, std::move(session.members),
                           std::move(aggregate)};
    }

    static bool window_order(const window_type& left, const window_type& right) {
        if (left.end != right.end) {
            return left.end < right.end;
        }
        if (left.start != right.start) {
            return left.start < right.start;
        }
        return left.key < right.key;
    }

    timestamp_t gap_{};
    std::optional<timestamp_t> watermark_{};
    sequence_t next_sequence_{};
    std::map<Key, std::vector<open_session>> open_sessions_{};
};

template <class Key = std::string, class Value = std::int64_t>
using SessionWindowState = session_window_state<Key, Value>;

}  // namespace dlks_formal
