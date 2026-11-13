#pragma once

#include <concepts>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <span>
#include <stdexcept>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dataeng {

using multiplicity_t = std::int64_t;

class transaction_error : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

template <class Value>
struct Aggregate {
  Value sum{};
  multiplicity_t count{};
  Value min{};
  Value max{};

  friend bool operator==(const Aggregate&, const Aggregate&) = default;
};

template <class Value>
using GroupAggregate = Aggregate<Value>;

template <class Value>
concept AggregateValue =
    std::copyable<Value> && std::default_initializable<Value> &&
    std::totally_ordered<Value> &&
    requires(Value value, const Value& other, multiplicity_t multiplicity) {
      { value += other } -> std::same_as<Value&>;
      { value -= other } -> std::same_as<Value&>;
      { other * multiplicity } -> std::convertible_to<Value>;
    };

template <class Key, class Value, class Hash = std::hash<Key>,
          class KeyEqual = std::equal_to<Key>,
          class Compare = std::less<Value>>
  requires AggregateValue<Value>
class IncrementalAggregator {
 private:
  struct GroupState {
    Value sum{};
    multiplicity_t count{};
    std::map<Value, multiplicity_t, Compare> ordered;
  };

  using StateMap =
      std::unordered_map<Key, std::shared_ptr<const GroupState>, Hash, KeyEqual>;
  using ValueDeltas = std::map<Value, multiplicity_t, Compare>;
  using GroupDeltas = std::unordered_map<Key, ValueDeltas, Hash, KeyEqual>;

  static Aggregate<Value> aggregate_of(const GroupState& group) {
    return Aggregate<Value>{group.sum, group.count, group.ordered.begin()->first,
                            group.ordered.rbegin()->first};
  }

 public:
  struct Row {
    Key key;
    Value value;
    multiplicity_t multiplicity{1};
  };

  class Snapshot {
   public:
    struct Entry {
      Key key;
      Aggregate<Value> aggregate;
    };

    class const_iterator {
     public:
      using iterator_category = std::forward_iterator_tag;
      using value_type = Entry;
      using difference_type = std::ptrdiff_t;
      using pointer = void;
      using reference = Entry;

      const_iterator() = default;

      Entry operator*() const {
        return Entry{iterator_->first,
                     IncrementalAggregator::aggregate_of(*iterator_->second)};
      }

      const_iterator& operator++() {
        ++iterator_;
        return *this;
      }

      const_iterator operator++(int) {
        const_iterator copy = *this;
        ++iterator_;
        return copy;
      }

      bool operator==(const const_iterator& other) const {
        return owner_ == other.owner_ && iterator_ == other.iterator_;
      }

      bool operator!=(const const_iterator& other) const {
        return !(*this == other);
      }

     private:
      const_iterator(const Snapshot* owner,
                     typename StateMap::const_iterator iterator)
          : owner_(owner), iterator_(iterator) {}

      const Snapshot* owner_{nullptr};
      typename StateMap::const_iterator iterator_{};

      friend class Snapshot;
    };

    std::optional<Aggregate<Value>> find(const Key& key) const {
      const auto it = groups_.find(key);
      if (it == groups_.end()) {
        return std::nullopt;
      }
      return IncrementalAggregator::aggregate_of(*it->second);
    }

    bool contains(const Key& key) const { return groups_.contains(key); }

    std::optional<std::size_t> distinct_value_count(const Key& key) const {
      const auto it = groups_.find(key);
      if (it == groups_.end()) {
        return std::nullopt;
      }
      return it->second->ordered.size();
    }

    std::size_t size() const noexcept { return groups_.size(); }
    bool empty() const noexcept { return groups_.empty(); }

    const_iterator begin() const noexcept {
      return const_iterator(this, groups_.begin());
    }

    const_iterator end() const noexcept {
      return const_iterator(this, groups_.end());
    }

   private:
    explicit Snapshot(StateMap groups) : groups_(std::move(groups)) {}

    StateMap groups_;

    friend class IncrementalAggregator;
  };

  class Transaction {
   public:
    Transaction& insert(Key key, Value value, multiplicity_t multiplicity = 1) {
      if (multiplicity <= 0) {
        throw transaction_error("insert multiplicity must be positive");
      }
      rows_.push_back(Row{std::move(key), std::move(value), multiplicity});
      return *this;
    }

    Transaction& retract(Key key, Value value, multiplicity_t multiplicity = 1) {
      if (multiplicity <= 0) {
        throw transaction_error("retract multiplicity must be positive");
      }
      rows_.push_back(Row{std::move(key), std::move(value), -multiplicity});
      return *this;
    }

    Transaction& add(Row row) {
      rows_.push_back(std::move(row));
      return *this;
    }

    bool empty() const noexcept { return rows_.empty(); }
    std::size_t size() const noexcept { return rows_.size(); }
    const std::vector<Row>& rows() const noexcept { return rows_; }

   private:
    std::vector<Row> rows_;
  };

  IncrementalAggregator() = default;
  IncrementalAggregator(const IncrementalAggregator&) = delete;
  IncrementalAggregator& operator=(const IncrementalAggregator&) = delete;

  void apply(std::span<const Row> rows) {
    GroupDeltas deltas = collect_deltas(rows);
    if (deltas.empty()) {
      return;
    }

    std::unique_lock lock(mutex_);
    std::vector<PendingChange> changes;
    changes.reserve(deltas.size());

    for (const auto& [key, delta] : deltas) {
      const auto existing = groups_.find(key);
      GroupState state;
      if (existing != groups_.end()) {
        state = *existing->second;
      }

      for (const auto& [value, multiplicity] : delta) {
        const auto ordered_it = state.ordered.find(value);
        const multiplicity_t current =
            ordered_it == state.ordered.end() ? 0 : ordered_it->second;
        const multiplicity_t updated = checked_add(current, multiplicity);
        if (updated < 0) {
          throw transaction_error("retraction exceeds value multiplicity");
        }

        state.count = checked_add(state.count, multiplicity);
        if constexpr (std::is_arithmetic_v<Value>) {
          state.sum += value * static_cast<Value>(multiplicity);
        } else {
          state.sum += value * multiplicity;
        }

        if (updated == 0) {
          state.ordered.erase(ordered_it);
        } else if (ordered_it == state.ordered.end()) {
          state.ordered.emplace(value, updated);
        } else {
          ordered_it->second = updated;
        }
      }

      if (state.count < 0) {
        throw transaction_error("retraction makes group count negative");
      }

      if (state.count == 0) {
        if (!state.ordered.empty()) {
          throw transaction_error("inconsistent group state");
        }
        changes.push_back(PendingChange{key, nullptr});
      } else {
        if (state.ordered.empty()) {
          throw transaction_error("inconsistent group state");
        }
        changes.push_back(PendingChange{
            key, std::make_shared<const GroupState>(std::move(state))});
      }
    }

    commit(std::move(changes));
    ++revision_;
  }

  void apply(std::initializer_list<Row> rows) {
    apply(std::span<const Row>(rows.begin(), rows.size()));
  }

  void apply(const Row& row) {
    apply(std::span<const Row>(&row, 1));
  }

  void apply(const std::vector<Row>& rows) {
    apply(std::span<const Row>(rows.data(), rows.size()));
  }

  void apply(const Transaction& transaction) {
    apply(std::span<const Row>(transaction.rows().data(),
                               transaction.rows().size()));
  }

  void insert(Key key, Value value, multiplicity_t multiplicity = 1) {
    Transaction transaction;
    transaction.insert(std::move(key), std::move(value), multiplicity);
    apply(transaction);
  }

  void retract(Key key, Value value, multiplicity_t multiplicity = 1) {
    Transaction transaction;
    transaction.retract(std::move(key), std::move(value), multiplicity);
    apply(transaction);
  }

  std::shared_ptr<const Snapshot> snapshot() const {
    std::shared_lock lock(mutex_);
    return std::shared_ptr<const Snapshot>(new Snapshot(groups_));
  }

  std::optional<Aggregate<Value>> find(const Key& key) const {
    std::shared_lock lock(mutex_);
    const auto it = groups_.find(key);
    if (it == groups_.end()) {
      return std::nullopt;
    }
    return aggregate_of(*it->second);
  }

  bool contains(const Key& key) const {
    std::shared_lock lock(mutex_);
    return groups_.contains(key);
  }

  std::size_t size() const {
    std::shared_lock lock(mutex_);
    return groups_.size();
  }

  bool empty() const {
    std::shared_lock lock(mutex_);
    return groups_.empty();
  }

  std::uint64_t revision() const {
    std::shared_lock lock(mutex_);
    return revision_;
  }

 private:
  struct PendingChange {
    Key key;
    std::shared_ptr<const GroupState> state;
  };

  static multiplicity_t checked_add(multiplicity_t lhs, multiplicity_t rhs) {
    constexpr multiplicity_t minimum =
        std::numeric_limits<multiplicity_t>::min();
    constexpr multiplicity_t maximum =
        std::numeric_limits<multiplicity_t>::max();
    if ((rhs > 0 && lhs > maximum - rhs) ||
        (rhs < 0 && lhs < minimum - rhs)) {
      throw transaction_error("multiplicity overflow");
    }
    return lhs + rhs;
  }

  static GroupDeltas collect_deltas(std::span<const Row> rows) {
    GroupDeltas deltas;
    for (const Row& row : rows) {
      if (row.multiplicity == 0) {
        continue;
      }

      auto group_it = deltas.find(row.key);
      if (group_it == deltas.end()) {
        group_it = deltas.emplace(row.key, ValueDeltas{}).first;
      }

      auto& values = group_it->second;
      auto value_it = values.find(row.value);
      if (value_it == values.end()) {
        value_it = values.emplace(row.value, row.multiplicity).first;
      } else {
        value_it->second = checked_add(value_it->second, row.multiplicity);
      }

      if (value_it->second == 0) {
        values.erase(value_it);
      }
      if (values.empty()) {
        deltas.erase(group_it);
      }
    }
    return deltas;
  }

  void commit(std::vector<PendingChange> changes) {
    std::vector<const Key*> inserted;
    inserted.reserve(changes.size());
    groups_.reserve(groups_.size() + changes.size());

    try {
      for (const PendingChange& change : changes) {
        if (change.state && !groups_.contains(change.key)) {
          groups_.emplace(change.key, nullptr);
          inserted.push_back(&change.key);
        }
      }
    } catch (...) {
      for (const Key* key : inserted) {
        groups_.erase(*key);
      }
      throw;
    }

    for (PendingChange& change : changes) {
      const auto it = groups_.find(change.key);
      if (it != groups_.end()) {
        it->second = change.state;
      }
    }

    for (const PendingChange& change : changes) {
      if (!change.state) {
        groups_.erase(change.key);
      }
    }
  }

  mutable std::shared_mutex mutex_;
  StateMap groups_;
  std::uint64_t revision_{0};
};

template <class Key, class Value, class Hash = std::hash<Key>,
          class KeyEqual = std::equal_to<Key>,
          class Compare = std::less<Value>>
using AggregationState =
    IncrementalAggregator<Key, Value, Hash, KeyEqual, Compare>;

}  // namespace dataeng
