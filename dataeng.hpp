#pragma once

#include <cstddef>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace dataeng {

using GroupId = std::string;
using Key = std::string;
using Score = double;

// A ranked row: identity is `key`; `group` and `score` are mutable attributes.
struct Record {
  GroupId group;
  Key key;
  Score score;

  friend bool operator==(const Record&, const Record&) = default;
};

enum class ChangeKind { Retract, Insert };

// One changelog entry emitted by the operator.
struct Change {
  ChangeKind kind;
  Record record;

  friend bool operator==(const Change&, const Change&) = default;
};

enum class EventType { Insert, UpdateBefore, UpdateAfter, Delete };

struct Event {
  EventType type;
  Record record;
};

// Streaming Top-K operator with retract semantics.
//
// Maintains, per group, the K highest-ranked records ordered by score
// descending with the key ascending as a stable tie-breaker. Every applied
// event yields the minimal retract/insert delta against the previously
// emitted top-K. An update that moves a key to another group is applied as
// one atomic cross-group transaction: the old group's delta (retract plus a
// possible promotion insert) is emitted first, then the new group's delta
// (eviction retract plus insert).
//
// update_before emits nothing; it latches the pre-image which update_after
// consumes to perform the atomic transition. Restoring a snapshot reproduces
// the exact output sequence of an uninterrupted run.
//
// Precondition violations (insert of an existing key, update/delete of an
// unknown key, payload that mismatches tracked state, NaN scores) throw
// std::invalid_argument and leave the operator unchanged.
class TopKOperator {
  struct MemberOrder {
    bool operator()(const Record& lhs, const Record& rhs) const {
      if (lhs.score != rhs.score) return lhs.score > rhs.score;
      return lhs.key < rhs.key;
    }
  };
  using OrderedMembers = std::set<Record, MemberOrder>;

 public:
  explicit TopKOperator(std::size_t k);

  std::vector<Change> apply(const Event& event);
  std::vector<Change> insert(Record record);
  std::vector<Change> updateBefore(Record record);
  std::vector<Change> updateAfter(Record record);
  std::vector<Change> erase(Record record);

  // Opaque, copyable state checkpoint.
  struct Snapshot {
   private:
    std::unordered_map<Key, Record> index_;
    std::unordered_map<GroupId, OrderedMembers> groups_;
    std::optional<Record> pending_before_;
    friend class TopKOperator;
  };

  Snapshot snapshot() const;
  void restore(const Snapshot& snapshot);

  std::size_t k() const { return k_; }
  std::size_t size() const { return index_.size(); }
  bool contains(const Key& key) const { return index_.contains(key); }

  // Current top-K of a group, in rank order.
  std::vector<Record> topK(const GroupId& group) const;

 private:
  std::vector<Record> topKOf(const GroupId& group) const;
  std::vector<Change> transition(const Record& before, const Record& after);
  std::vector<Change> addRecord(const Record& record);
  std::vector<Change> removeRecord(const Record& record);
  void insertInternal(const Record& record);
  void eraseInternal(const Record& record);

  std::size_t k_;
  std::unordered_map<Key, Record> index_;
  std::unordered_map<GroupId, OrderedMembers> groups_;
  std::optional<Record> pending_before_;
};

}  // namespace dataeng
