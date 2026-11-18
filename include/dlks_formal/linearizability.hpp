#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace dlks {

enum class HistoryOperationKind : std::uint8_t {
    insert,
    upsert,
    erase,
    find
};

template <typename Key, typename Value>
struct HistoryOperation {
    std::uint64_t start = 0;
    std::uint64_t end = 0;
    HistoryOperationKind kind = HistoryOperationKind::find;
    Key key{};
    std::optional<Value> argument;
    bool bool_result = false;
    std::optional<Value> value_result;
};

// Tick-based invocation/response history.  Ticks must be acquired before the
// call and after the response; conservative overlap is harmless to the checker.
template <typename Key, typename Value>
class OperationHistory {
public:
    OperationHistory() = default;

    [[nodiscard]] std::uint64_t tick() noexcept {
        return clock_.fetch_add(1, std::memory_order_relaxed);
    }

    void record_insert(std::uint64_t start, std::uint64_t end,
                       const Key& key, const Value& value, bool inserted) {
        HistoryOperation<Key, Value> operation;
        operation.start = start;
        operation.end = end;
        operation.kind = HistoryOperationKind::insert;
        operation.key = key;
        operation.argument = value;
        operation.bool_result = inserted;
        push(std::move(operation));
    }

    void record_upsert(std::uint64_t start, std::uint64_t end,
                       const Key& key, const Value& value, bool inserted) {
        HistoryOperation<Key, Value> operation;
        operation.start = start;
        operation.end = end;
        operation.kind = HistoryOperationKind::upsert;
        operation.key = key;
        operation.argument = value;
        operation.bool_result = inserted;
        push(std::move(operation));
    }

    void record_erase(std::uint64_t start, std::uint64_t end,
                      const Key& key, bool erased) {
        HistoryOperation<Key, Value> operation;
        operation.start = start;
        operation.end = end;
        operation.kind = HistoryOperationKind::erase;
        operation.key = key;
        operation.bool_result = erased;
        push(std::move(operation));
    }

    void record_find(std::uint64_t start, std::uint64_t end, const Key& key,
                     const std::optional<Value>& result) {
        HistoryOperation<Key, Value> operation;
        operation.start = start;
        operation.end = end;
        operation.kind = HistoryOperationKind::find;
        operation.key = key;
        operation.value_result = result;
        push(std::move(operation));
    }

    [[nodiscard]] std::vector<HistoryOperation<Key, Value>> operations()
        const {
        std::lock_guard<std::mutex> lock(mutex_);
        return operations_;
    }

    [[nodiscard]] std::size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return operations_.size();
    }

    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        operations_.clear();
    }

private:
    void push(HistoryOperation<Key, Value> operation) {
        std::lock_guard<std::mutex> lock(mutex_);
        operations_.push_back(std::move(operation));
    }

    mutable std::mutex mutex_;
    std::vector<HistoryOperation<Key, Value>> operations_;
    std::atomic<std::uint64_t> clock_{1};
};

enum class LinearizabilityStatus : std::uint8_t {
    linearizable,
    not_linearizable,
    unknown
};

template <typename Key>
struct LinearizabilityReport {
    LinearizabilityStatus status = LinearizabilityStatus::linearizable;
    std::size_t operations = 0;
    std::size_t keys = 0;
    std::size_t explored_states = 0;
    std::optional<Key> failing_key;
    std::string message;

    [[nodiscard]] bool ok() const noexcept {
        return status == LinearizabilityStatus::linearizable;
    }

    [[nodiscard]] explicit operator bool() const noexcept { return ok(); }
};

// The map specification is independent per key, so a global history is
// linearizable iff every per-key sub-history is.  Each sub-history is searched
// as a topological order of its real-time precedence relation.
template <typename Key, typename Value, typename Compare = std::less<Key>>
class LinearizabilityChecker {
public:
    explicit LinearizabilityChecker(Compare compare = Compare{})
        : compare_(std::move(compare)) {}

    [[nodiscard]] LinearizabilityReport<Key> check(
        const OperationHistory<Key, Value>& history,
        const std::map<Key, std::optional<Value>, Compare>& initial = {},
        std::size_t maximum_states = 2'000'000) const {
        return check(history.operations(), initial, maximum_states);
    }

    [[nodiscard]] LinearizabilityReport<Key> check(
        const std::vector<HistoryOperation<Key, Value>>& operations,
        const std::map<Key, std::optional<Value>, Compare>& initial = {},
        std::size_t maximum_states = 2'000'000) const {
        LinearizabilityReport<Key> report;
        report.operations = operations.size();
        report.keys = 0;

        std::map<Key, std::vector<const HistoryOperation<Key, Value>*>,
                 Compare>
            grouped(compare_);
        for (const auto& operation : operations) {
            if (operation.start > operation.end) {
                report.status = LinearizabilityStatus::not_linearizable;
                report.message = "operation interval is inverted";
                return report;
            }
            if ((operation.kind == HistoryOperationKind::insert ||
                 operation.kind == HistoryOperationKind::upsert) &&
                !operation.argument.has_value()) {
                throw std::invalid_argument(
                    "dlks::LinearizabilityChecker: write without argument");
            }
            grouped[operation.key].push_back(&operation);
        }

        std::size_t budget = maximum_states;
        for (auto& [key, group] : grouped) {
            ++report.keys;
            std::sort(group.begin(), group.end(),
                      [](const auto* left, const auto* right) {
                          if (left->start != right->start) {
                              return left->start < right->start;
                          }
                          return left->end < right->end;
                      });

            std::optional<Value> state;
            const auto initial_it = initial.find(key);
            if (initial_it != initial.end()) {
                state = initial_it->second;
            }

            const SearchResult result =
                search_key(group, state, budget, report.explored_states);
            if (result == SearchResult::not_linearizable) {
                report.status = LinearizabilityStatus::not_linearizable;
                report.failing_key = key;
                report.message =
                    "no sequential order matches the recorded results";
                return report;
            }
            if (result == SearchResult::budget_exhausted) {
                report.status = LinearizabilityStatus::unknown;
                report.failing_key = key;
                report.message =
                    "linearizability search exhausted its state budget";
                return report;
            }
        }
        return report;
    }

private:
    enum class SearchResult {
        found,
        not_linearizable,
        budget_exhausted
    };

    [[nodiscard]] static bool applies(
        const HistoryOperation<Key, Value>& operation,
        std::optional<Value>& state) {
        switch (operation.kind) {
            case HistoryOperationKind::insert: {
                const bool inserted = !state.has_value();
                if (inserted != operation.bool_result) {
                    return false;
                }
                if (inserted) {
                    state = *operation.argument;
                }
                return true;
            }
            case HistoryOperationKind::upsert: {
                const bool inserted = !state.has_value();
                if (inserted != operation.bool_result) {
                    return false;
                }
                state = *operation.argument;
                return true;
            }
            case HistoryOperationKind::erase: {
                const bool erased = state.has_value();
                if (erased != operation.bool_result) {
                    return false;
                }
                if (erased) {
                    state.reset();
                }
                return true;
            }
            case HistoryOperationKind::find:
                return state == operation.value_result;
        }
        return false;
    }

    [[nodiscard]] SearchResult search_key(
        const std::vector<const HistoryOperation<Key, Value>*>& operations,
        std::optional<Value> initial_state, std::size_t& budget,
        std::size_t& explored_states) const {
        const std::size_t count = operations.size();
        std::vector<std::vector<std::size_t>> predecessors(count);
        for (std::size_t current = 0; current < count; ++current) {
            for (std::size_t previous = 0; previous < count; ++previous) {
                if (previous == current) {
                    continue;
                }
                if (operations[previous]->end <
                    operations[current]->start) {
                    predecessors[current].push_back(previous);
                }
            }
        }

        std::vector<std::size_t> candidate_order(count);
        for (std::size_t index = 0; index < count; ++index) {
            candidate_order[index] = index;
        }
        std::sort(candidate_order.begin(), candidate_order.end(),
                  [&](std::size_t left, std::size_t right) {
                      if (operations[left]->end != operations[right]->end) {
                          return operations[left]->end <
                                 operations[right]->end;
                      }
                      return operations[left]->start <
                             operations[right]->start;
                  });

        const bool memoizable = count <= 64;
        using FailedState = std::pair<std::uint64_t, std::optional<Value>>;
        std::map<std::uint64_t, std::vector<FailedState>> failed;
        std::vector<std::uint8_t> done(count, 0);

        std::function<SearchResult(std::size_t, std::uint64_t,
                                   std::uint64_t,
                                   const std::optional<Value>&)>
            visit;
        visit = [&](std::size_t remaining, std::uint64_t now,
                    std::uint64_t mask,
                    const std::optional<Value>& state) -> SearchResult {
            if (remaining == 0) {
                return SearchResult::found;
            }
            if (budget == 0) {
                return SearchResult::budget_exhausted;
            }
            --budget;
            ++explored_states;

            if (memoizable) {
                const auto memo_it = failed.find(mask);
                if (memo_it != failed.end()) {
                    for (const auto& failed_state : memo_it->second) {
                        if (failed_state.first == now &&
                            failed_state.second == state) {
                            return SearchResult::not_linearizable;
                        }
                    }
                }
            }

            for (const std::size_t index : candidate_order) {
                if (done[index] != 0) {
                    continue;
                }
                bool ready = true;
                for (const std::size_t predecessor : predecessors[index]) {
                    if (done[predecessor] == 0) {
                        ready = false;
                        break;
                    }
                }
                if (!ready) {
                    continue;
                }
                const std::uint64_t linearization_time =
                    std::max(now, operations[index]->start);
                if (linearization_time > operations[index]->end) {
                    continue;
                }

                std::optional<Value> next_state = state;
                if (!applies(*operations[index], next_state)) {
                    continue;
                }

                done[index] = 1;
                const std::uint64_t next_mask =
                    memoizable ? (mask | (std::uint64_t{1} << index)) : mask;
                const SearchResult result =
                    visit(remaining - 1, linearization_time, next_mask,
                          next_state);
                done[index] = 0;
                if (result != SearchResult::not_linearizable) {
                    return result;
                }
            }

            if (memoizable) {
                failed[mask].emplace_back(now, state);
            }
            return SearchResult::not_linearizable;
        };

        return visit(count, 0, 0, initial_state);
    }

    Compare compare_;
};

template <typename Key, typename Value, typename Compare = std::less<Key>>
[[nodiscard]] LinearizabilityReport<Key> check_history_linearizable(
    const OperationHistory<Key, Value>& history,
    const std::map<Key, std::optional<Value>, Compare>& initial = {},
    std::size_t maximum_states = 2'000'000,
    Compare compare = Compare{}) {
    return LinearizabilityChecker<Key, Value, Compare>(std::move(compare))
        .check(history, initial, maximum_states);
}

}  // namespace dlks
