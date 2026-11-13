#include "dataeng.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace dataeng {

namespace {

void validate(const Record& record) {
  if (std::isnan(record.score)) {
    throw std::invalid_argument("topk: score must not be NaN");
  }
}

// Minimal delta turning `before` into `after`; both are rank-ordered top-K
// lists of one group. Retracts (in old rank order) precede inserts (in new
// rank order).
std::vector<Change> diffTopK(const std::vector<Record>& before,
                             const std::vector<Record>& after) {
  std::vector<Change> changes;
  for (const Record& record : before) {
    if (std::find(after.begin(), after.end(), record) == after.end()) {
      changes.push_back({ChangeKind::Retract, record});
    }
  }
  for (const Record& record : after) {
    if (std::find(before.begin(), before.end(), record) == before.end()) {
      changes.push_back({ChangeKind::Insert, record});
    }
  }
  return changes;
}

}  // namespace

TopKOperator::TopKOperator(std::size_t k) : k_(k) {}

std::vector<Change> TopKOperator::apply(const Event& event) {
  switch (event.type) {
    case EventType::Insert:
      return insert(event.record);
    case EventType::UpdateBefore:
      return updateBefore(event.record);
    case EventType::UpdateAfter:
      return updateAfter(event.record);
    case EventType::Delete:
      return erase(event.record);
  }
  throw std::invalid_argument("topk: unknown event type");
}

std::vector<Change> TopKOperator::insert(Record record) {
  validate(record);
  if (index_.contains(record.key)) {
    throw std::invalid_argument("topk: insert of existing key: " + record.key);
  }
  return addRecord(record);
}

std::vector<Change> TopKOperator::updateBefore(Record record) {
  validate(record);
  const auto it = index_.find(record.key);
  if (it == index_.end()) {
    throw std::invalid_argument("topk: update_before of unknown key: " +
                                record.key);
  }
  if (it->second != record) {
    throw std::invalid_argument("topk: update_before does not match tracked "
                                "state of key: " +
                                record.key);
  }
  pending_before_ = std::move(record);
  return {};
}

std::vector<Change> TopKOperator::updateAfter(Record record) {
  validate(record);
  Record before;
  if (pending_before_ && pending_before_->key == record.key) {
    before = *pending_before_;
  } else {
    const auto it = index_.find(record.key);
    if (it == index_.end()) {
      throw std::invalid_argument("topk: update_after of unknown key: " +
                                  record.key);
    }
    before = it->second;
  }
  pending_before_.reset();
  if (before == record) {
    return {};
  }
  return transition(before, record);
}

std::vector<Change> TopKOperator::erase(Record record) {
  const auto it = index_.find(record.key);
  if (it == index_.end()) {
    throw std::invalid_argument("topk: delete of unknown key: " + record.key);
  }
  if (it->second != record) {
    throw std::invalid_argument("topk: delete does not match tracked state of "
                                "key: " +
                                record.key);
  }
  if (pending_before_ && pending_before_->key == record.key) {
    pending_before_.reset();
  }
  return removeRecord(record);
}

TopKOperator::Snapshot TopKOperator::snapshot() const {
  Snapshot snap;
  snap.index_ = index_;
  snap.groups_ = groups_;
  snap.pending_before_ = pending_before_;
  return snap;
}

void TopKOperator::restore(const Snapshot& snapshot) {
  index_ = snapshot.index_;
  groups_ = snapshot.groups_;
  pending_before_ = snapshot.pending_before_;
}

std::vector<Record> TopKOperator::topK(const GroupId& group) const {
  return topKOf(group);
}

std::vector<Record> TopKOperator::topKOf(const GroupId& group) const {
  std::vector<Record> top;
  const auto it = groups_.find(group);
  if (it == groups_.end()) {
    return top;
  }
  top.reserve(std::min(k_, it->second.size()));
  for (const Record& record : it->second) {
    if (top.size() == k_) {
      break;
    }
    top.push_back(record);
  }
  return top;
}

std::vector<Change> TopKOperator::transition(const Record& before,
                                             const Record& after) {
  if (before.group == after.group) {
    const std::vector<Record> previous = topKOf(before.group);
    eraseInternal(before);
    insertInternal(after);
    return diffTopK(previous, topKOf(after.group));
  }
  // Cross-group transaction: emit the source group's delta first, then the
  // target group's, so downstream never sees the key in two top-Ks at once.
  const std::vector<Record> previous_source = topKOf(before.group);
  const std::vector<Record> previous_target = topKOf(after.group);
  eraseInternal(before);
  insertInternal(after);
  std::vector<Change> changes =
      diffTopK(previous_source, topKOf(before.group));
  std::vector<Change> target_changes =
      diffTopK(previous_target, topKOf(after.group));
  changes.insert(changes.end(), target_changes.begin(), target_changes.end());
  return changes;
}

std::vector<Change> TopKOperator::addRecord(const Record& record) {
  const std::vector<Record> previous = topKOf(record.group);
  insertInternal(record);
  return diffTopK(previous, topKOf(record.group));
}

std::vector<Change> TopKOperator::removeRecord(const Record& record) {
  const std::vector<Record> previous = topKOf(record.group);
  eraseInternal(record);
  return diffTopK(previous, topKOf(record.group));
}

void TopKOperator::insertInternal(const Record& record) {
  groups_[record.group].insert(record);
  index_[record.key] = record;
}

void TopKOperator::eraseInternal(const Record& record) {
  const auto group_it = groups_.find(record.group);
  if (group_it != groups_.end()) {
    group_it->second.erase(record);
    if (group_it->second.empty()) {
      groups_.erase(group_it);
    }
  }
  index_.erase(record.key);
}

}  // namespace dataeng
