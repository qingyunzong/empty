#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <list>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace tilelib {

// Quadtree-style tile address: z = level, x/y = column/row within the level.
struct TileId {
  int z = 0;
  int x = 0;
  int y = 0;

  friend bool operator==(const TileId&, const TileId&) = default;

  // Coarser parent tile one level up. Only valid when z > 0.
  TileId parent() const { return TileId{z - 1, x / 2, y / 2}; }
};

struct TileIdHash {
  std::size_t operator()(const TileId& id) const noexcept {
    std::size_t h = std::hash<int>{}(id.z);
    h = h * 1315423911u + std::hash<int>{}(id.x);
    h = h * 1315423911u + std::hash<int>{}(id.y);
    return h;
  }
};

// A cached tile. `version` is the viewport generation that requested it;
// `pinned` marks tiles required by the current viewport (never evictable).
// `provenance` is the source evidence reported by the loader.
struct Tile {
  TileId id;
  std::vector<std::byte> bytes;
  std::string provenance;
  std::uint64_t version = 0;
  bool pinned = false;
};

// Result of resolving a tile for rendering. When the exact tile is missing,
// a cached ancestor may substitute: `exact` is false and `missing_levels`
// tells how many levels of precision are lacking.
struct ResolvedTile {
  const Tile* tile = nullptr;
  bool exact = false;
  int missing_levels = 0;
};

// Asynchronous tile source. Completion carries the handle and the viewport
// version under which the request was issued, so the cache can classify
// late arrivals from superseded viewports.
class Loader {
public:
  using Completion = std::function<void(std::uint64_t handle, TileId id,
                                        std::uint64_t version,
                                        std::vector<std::byte> bytes,
                                        std::string provenance)>;
  virtual ~Loader() = default;
  virtual std::uint64_t begin(TileId id, std::uint64_t version,
                              Completion completion) = 0;
  virtual void cancel(std::uint64_t handle) = 0;
};

// Controllable loader: nothing completes unless the caller drives it.
// Cancellation is best-effort (like a network race): a cancelled load moves
// to a zombie state and may still be completed explicitly to model late
// results arriving after cancellation.
class ManualLoader : public Loader {
public:
  std::uint64_t begin(TileId id, std::uint64_t version,
                      Completion completion) override;
  void cancel(std::uint64_t handle) override;

  // Drives a pending or cancelled (zombie) load to completion. Returns
  // false when the handle is unknown.
  bool complete(std::uint64_t handle, std::vector<std::byte> bytes,
                std::string provenance);

  struct Pending {
    std::uint64_t handle;
    TileId id;
    std::uint64_t version;
  };

  std::vector<Pending> pending() const;
  const std::vector<std::uint64_t>& cancelled() const { return cancelled_; }
  std::size_t beginCount() const { return begin_count_; }

private:
  struct InFlight {
    TileId id;
    std::uint64_t version;
    Completion completion;
  };

  std::uint64_t next_handle_ = 1;
  std::size_t begin_count_ = 0;
  std::unordered_map<std::uint64_t, InFlight> pending_;
  std::unordered_map<std::uint64_t, InFlight> zombies_;
  std::vector<std::uint64_t> cancelled_;
};

// Versioned, byte-budgeted tile cache driven by viewport generations.
//
// Invariants:
//  - usedBytes() == sum of cached tile bytes, and usedBytes() <= budget()
//    (byte budget conservation).
//  - Tiles pinned by the current viewport are never evicted; late results
//    from older versions are admitted only into leftover capacity and are
//    dropped (not displacing required tiles) when they do not fit.
class TileCache {
public:
  TileCache(std::size_t byte_budget, Loader& loader);

  // Advances to a new viewport generation: pins required tiles, cancels
  // in-flight loads no longer needed, and starts loads for missing ones.
  void setViewport(const std::vector<TileId>& required);

  // Exact tile if cached, otherwise the nearest cached ancestor marked as
  // a lower-precision substitute. {nullptr, false, 0} when nothing matches.
  ResolvedTile resolve(TileId id) const;

  const Tile* find(TileId id) const;

  std::size_t usedBytes() const { return used_bytes_; }
  std::size_t summedBytes() const;  // recomputed from entries, for audits
  std::size_t budget() const { return budget_; }
  std::size_t size() const { return entries_.size(); }
  std::uint64_t version() const { return version_; }
  std::size_t pendingCount() const { return inflight_.size(); }
  std::size_t evictedCount() const { return evicted_; }
  std::size_t droppedCount() const { return dropped_; }

private:
  struct Entry;

  void accept(std::uint64_t handle, TileId id, std::uint64_t version,
              std::vector<std::byte> bytes, std::string provenance);
  bool evictOneUnpinned();
  void touch(std::unordered_map<TileId, Entry, TileIdHash>::iterator it);

  struct Entry {
    Tile tile;
    std::list<TileId>::iterator lru_it;
  };

  std::size_t budget_;
  Loader& loader_;
  std::uint64_t version_ = 0;
  std::size_t used_bytes_ = 0;
  std::size_t evicted_ = 0;
  std::size_t dropped_ = 0;
  std::unordered_set<TileId, TileIdHash> required_;
  std::unordered_map<TileId, Entry, TileIdHash> entries_;
  std::list<TileId> lru_;  // front = most recently used
  std::unordered_map<std::uint64_t, TileId> inflight_;
};

}  // namespace tilelib
