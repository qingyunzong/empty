#include "tilelib/tilelib.hpp"

#include <utility>

namespace tilelib {

std::uint64_t ManualLoader::begin(TileId id, std::uint64_t version,
                                  Completion completion) {
  const std::uint64_t handle = next_handle_++;
  ++begin_count_;
  pending_.emplace(handle, InFlight{id, version, std::move(completion)});
  return handle;
}

void ManualLoader::cancel(std::uint64_t handle) {
  auto it = pending_.find(handle);
  if (it == pending_.end()) {
    return;
  }
  // Best-effort cancellation: the load may still complete later (zombie).
  zombies_.emplace(handle, std::move(it->second));
  pending_.erase(it);
  cancelled_.push_back(handle);
}

bool ManualLoader::complete(std::uint64_t handle, std::vector<std::byte> bytes,
                            std::string provenance) {
  auto it = pending_.find(handle);
  if (it != pending_.end()) {
    InFlight in_flight = std::move(it->second);
    pending_.erase(it);
    in_flight.completion(handle, in_flight.id, in_flight.version,
                         std::move(bytes), std::move(provenance));
    return true;
  }
  auto zombie = zombies_.find(handle);
  if (zombie == zombies_.end()) {
    return false;
  }
  InFlight in_flight = std::move(zombie->second);
  zombies_.erase(zombie);
  in_flight.completion(handle, in_flight.id, in_flight.version,
                       std::move(bytes), std::move(provenance));
  return true;
}

std::vector<ManualLoader::Pending> ManualLoader::pending() const {
  std::vector<Pending> out;
  out.reserve(pending_.size());
  for (const auto& [handle, in_flight] : pending_) {
    out.push_back(Pending{handle, in_flight.id, in_flight.version});
  }
  return out;
}

TileCache::TileCache(std::size_t byte_budget, Loader& loader)
    : budget_(byte_budget), loader_(loader) {}

void TileCache::setViewport(const std::vector<TileId>& required) {
  ++version_;
  required_.clear();
  required_.insert(required.begin(), required.end());

  for (auto& [id, entry] : entries_) {
    entry.tile.pinned = false;
  }

  // Cancel in-flight loads the new viewport no longer needs.
  for (auto it = inflight_.begin(); it != inflight_.end();) {
    if (required_.contains(it->second)) {
      ++it;
    } else {
      loader_.cancel(it->first);
      it = inflight_.erase(it);
    }
  }

  std::unordered_set<TileId, TileIdHash> inflight_ids;
  for (const auto& [handle, id] : inflight_) {
    inflight_ids.insert(id);
  }

  for (const TileId& id : required_) {
    auto it = entries_.find(id);
    if (it != entries_.end()) {
      it->second.tile.pinned = true;
      it->second.tile.version = version_;
      touch(it);
      continue;
    }
    if (inflight_ids.contains(id)) {
      continue;
    }
    const std::uint64_t handle =
        loader_.begin(id, version_,
                      [this](std::uint64_t h, TileId tid, std::uint64_t v,
                             std::vector<std::byte> bytes,
                             std::string provenance) {
                        accept(h, tid, v, std::move(bytes),
                               std::move(provenance));
                      });
    inflight_.emplace(handle, id);
  }
}

void TileCache::accept(std::uint64_t handle, TileId id, std::uint64_t version,
                       std::vector<std::byte> bytes, std::string provenance) {
  inflight_.erase(handle);
  const bool pinned = required_.contains(id);

  auto existing = entries_.find(id);
  const std::size_t old_bytes =
      existing != entries_.end() ? existing->second.tile.bytes.size() : 0;

  // Make room without ever evicting tiles pinned by the current viewport.
  // Late (old-version) arrivals therefore can only use leftover capacity.
  while (used_bytes_ - old_bytes + bytes.size() > budget_ &&
         evictOneUnpinned()) {
  }
  if (used_bytes_ - old_bytes + bytes.size() > budget_) {
    ++dropped_;  // does not fit without displacing required tiles
    return;
  }

  if (existing != entries_.end()) {
    Entry& entry = existing->second;
    used_bytes_ -= old_bytes;
    entry.tile.bytes = std::move(bytes);
    entry.tile.provenance = std::move(provenance);
    entry.tile.version = pinned ? version_ : version;
    entry.tile.pinned = entry.tile.pinned || pinned;
    used_bytes_ += entry.tile.bytes.size();
    touch(existing);
    return;
  }

  lru_.push_front(id);
  Entry entry;
  entry.tile = Tile{id, std::move(bytes), std::move(provenance),
                    pinned ? version_ : version, pinned};
  entry.lru_it = lru_.begin();
  used_bytes_ += entry.tile.bytes.size();
  entries_.emplace(id, std::move(entry));
}

bool TileCache::evictOneUnpinned() {
  for (auto it = lru_.rbegin(); it != lru_.rend(); ++it) {
    auto entry = entries_.find(*it);
    if (entry == entries_.end() || entry->second.tile.pinned) {
      continue;
    }
    used_bytes_ -= entry->second.tile.bytes.size();
    entries_.erase(entry);
    lru_.erase(std::next(it).base());
    ++evicted_;
    return true;
  }
  return false;
}

void TileCache::touch(
    std::unordered_map<TileId, Entry, TileIdHash>::iterator it) {
  lru_.splice(lru_.begin(), lru_, it->second.lru_it);
}

ResolvedTile TileCache::resolve(TileId id) const {
  for (int levels_up = 0;; ++levels_up) {
    auto it = entries_.find(id);
    if (it != entries_.end()) {
      return ResolvedTile{&it->second.tile, levels_up == 0, levels_up};
    }
    if (id.z == 0) {
      return ResolvedTile{nullptr, false, levels_up};
    }
    id = id.parent();
  }
}

const Tile* TileCache::find(TileId id) const {
  auto it = entries_.find(id);
  return it != entries_.end() ? &it->second.tile : nullptr;
}

std::size_t TileCache::summedBytes() const {
  std::size_t total = 0;
  for (const auto& [id, entry] : entries_) {
    total += entry.tile.bytes.size();
  }
  return total;
}

}  // namespace tilelib
