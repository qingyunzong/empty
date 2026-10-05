#pragma once

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

#include "spatial/tree.hpp"

namespace spatial {

// Owns the live object set. Writers serialize on a mutex; every mutation
// rebuilds an immutable Snapshot and publishes it with a single atomic
// store, so a batch of moves becomes visible all at once. Readers acquire
// the snapshot with an atomic load and may keep querying it for as long as
// they hold the shared_ptr -- older snapshots stay valid.
class Space {
 public:
  ObjectId add(const Aabb& box) {
    std::lock_guard<std::mutex> lock(mutex_);
    const ObjectId id = next_id_++;
    objects_[id] = box;
    publish_locked();
    return id;
  }

  bool remove(ObjectId id) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (objects_.erase(id) == 0) return false;
    publish_locked();
    return true;
  }

  // Applies all moves, then publishes exactly once (atomic batch).
  void move_batch(const std::vector<std::pair<ObjectId, Aabb>>& moves) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [id, box] : moves) {
      auto it = objects_.find(id);
      if (it != objects_.end()) it->second = box;
    }
    publish_locked();
  }

  std::shared_ptr<const Snapshot> snapshot() const {
    return published_.load();
  }

 private:
  void publish_locked() {
    std::vector<Entry> entries;
    entries.reserve(objects_.size());
    for (const auto& [id, box] : objects_) entries.push_back({id, box});
    published_.store(std::make_shared<const Snapshot>(std::move(entries)));
  }

  std::mutex mutex_;
  std::map<ObjectId, Aabb> objects_;
  ObjectId next_id_ = 1;
  std::atomic<std::shared_ptr<const Snapshot>> published_{
      std::make_shared<const Snapshot>(std::vector<Entry>{})};
};

}  // namespace spatial
