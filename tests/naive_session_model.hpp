#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace naive {

using timestamp = std::int64_t;
using sequence = std::uint64_t;

struct event {
    std::string key{};
    timestamp time{};
    std::int64_t value{};
    sequence seq{};

    friend bool operator==(const event&, const event&) = default;
};

struct window {
    std::string key{};
    timestamp start{};
    timestamp end{};
    std::vector<event> members{};
    std::int64_t aggregate{};

    friend bool operator==(const window&, const window&) = default;
};

struct result {
    std::vector<window> closed{};
    std::vector<event> late{};

    friend bool operator==(const result&, const result&) = default;
};

// Deliberately simple reference state machine. It does not know about the
// implementation under test: on every watermark it re-sorts and regroups every
// still-open event from scratch.
class session_model {
public:
    explicit session_model(timestamp gap) : gap_(gap) {
        if (gap < 0) {
            throw std::invalid_argument("gap must be non-negative");
        }
    }

    result process(const std::string& key, timestamp time, std::int64_t value) {
        result result;
        event accepted{key, time, value, next_sequence_++};
        if (watermark_ && time < *watermark_) {
            result.late.push_back(std::move(accepted));
        } else {
            open_.push_back(std::move(accepted));
        }
        return result;
    }

    result advance(timestamp watermark) {
        if (watermark_ && watermark < *watermark_) {
            throw std::invalid_argument("watermark must not move backwards");
        }

        result result;
        if (watermark_ && watermark == *watermark_) {
            return result;
        }
        watermark_ = watermark;

        std::map<std::string, std::vector<std::size_t>> by_key;
        for (std::size_t index = 0; index < open_.size(); ++index) {
            by_key[open_[index].key].push_back(index);
        }

        std::vector<bool> remove(open_.size(), false);
        for (auto& [key, group] : by_key) {
            std::sort(group.begin(), group.end(), [this](std::size_t left, std::size_t right) {
                if (open_[left].time != open_[right].time) {
                    return open_[left].time < open_[right].time;
                }
                return open_[left].seq < open_[right].seq;
            });

            std::size_t first = 0;
            while (first < group.size()) {
                std::size_t last = first + 1;
                while (last < group.size() &&
                       distance(open_[group[last - 1]].time,
                                open_[group[last]].time) <= static_cast<std::uint64_t>(gap_)) {
                    ++last;
                }

                const timestamp end = open_[group[last - 1]].time;
                if (watermark > end &&
                    distance(end, watermark) > static_cast<std::uint64_t>(gap_)) {
                    window closed;
                    closed.key = key;
                    closed.start = open_[group[first]].time;
                    closed.end = end;
                    for (std::size_t pos = first; pos < last; ++pos) {
                        closed.members.push_back(open_[group[pos]]);
                        remove[group[pos]] = true;
                    }
                    for (const auto& member : closed.members) {
                        closed.aggregate += member.value;
                    }
                    result.closed.push_back(std::move(closed));
                }
                first = last;
            }
        }

        std::vector<event> remaining;
        remaining.reserve(open_.size());
        for (std::size_t i = 0; i < open_.size(); ++i) {
            if (!remove[i]) {
                remaining.push_back(std::move(open_[i]));
            }
        }
        open_ = std::move(remaining);

        std::sort(result.closed.begin(), result.closed.end(),
                  [](const window& left, const window& right) {
                      if (left.end != right.end) {
                          return left.end < right.end;
                      }
                      if (left.start != right.start) {
                          return left.start < right.start;
                      }
                      return left.key < right.key;
                  });
        return result;
    }

    void set_gap(timestamp gap) {
        if (gap < 0) {
            throw std::invalid_argument("gap must be non-negative");
        }
        gap_ = gap;
    }

    [[nodiscard]] timestamp gap() const noexcept { return gap_; }
    [[nodiscard]] std::optional<timestamp> watermark() const noexcept { return watermark_; }

private:
    static std::uint64_t distance(timestamp left, timestamp right) noexcept {
        return static_cast<std::uint64_t>(right) - static_cast<std::uint64_t>(left);
    }

    timestamp gap_{};
    std::optional<timestamp> watermark_{};
    sequence next_sequence_{};
    std::vector<event> open_{};
};

}  // namespace naive
