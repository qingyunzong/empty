#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <limits>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dlks_formal {

enum class SegmentState : std::uint8_t {
  Free = 0,
  Active = 1,
  Sealed = 2,
  Cleaning = 3,
};

enum class CleanMode : std::uint8_t {
  None = 0,
  Relocate = 1,
  InPlace = 2,
};

enum class CleanStepResult : std::uint8_t {
  Idle = 0,
  Copied = 1,
  Skipped = 2,
  Finished = 3,
  NoSpace = 4,
};

struct SegmentStoreConfig {
  std::size_t segment_capacity = 4096;
  std::size_t segment_count = 8;
};

struct SegmentStats {
  std::uint32_t id = 0;
  SegmentState state = SegmentState::Free;
  std::size_t capacity_bytes = 0;
  std::size_t used_bytes = 0;
  std::size_t reserved_bytes = 0;
  std::size_t free_bytes = 0;
  std::size_t live_bytes = 0;
  std::size_t dead_bytes = 0;
  std::size_t record_count = 0;
  std::size_t live_record_count = 0;
};

struct StoreStats {
  std::size_t segment_count = 0;
  std::size_t segment_capacity = 0;
  std::size_t capacity_bytes = 0;
  std::size_t used_bytes = 0;
  std::size_t free_bytes = 0;
  std::size_t reserved_bytes = 0;
  std::size_t available_bytes = 0;
  std::size_t live_bytes = 0;
  std::size_t live_user_bytes = 0;
  std::size_t live_tombstone_bytes = 0;
  std::size_t dead_bytes = 0;
  std::size_t record_count = 0;
  std::size_t live_record_count = 0;
  std::size_t tombstone_record_count = 0;
  std::uint64_t version = 0;
  std::uint64_t reclaimed_bytes = 0;
  bool cleaning_active = false;
  std::vector<SegmentStats> segments;
};

// A single store lock is held for every operation. Writers, readers, and the
// stepwise cleaner may therefore be driven from any number of threads without
// external synchronisation.
template <class Key = std::uint64_t,
          class Value = std::uint64_t,
          class Hash = std::hash<Key>,
          class KeyEqual = std::equal_to<Key>>
class SegmentStore {
 public:
  using key_type = Key;
  using value_type = Value;
  using config_type = SegmentStoreConfig;
  static constexpr std::uint32_t no_segment =
      std::numeric_limits<std::uint32_t>::max();

  struct RecordView {
    Key key{};
    std::optional<Value> value;
    std::uint64_t version = 0;
    std::size_t bytes = 0;
  };

  struct SegmentView {
    std::uint32_t id = 0;
    SegmentState state = SegmentState::Free;
    std::size_t capacity_bytes = 0;
    std::size_t used_bytes = 0;
    std::size_t reserved_bytes = 0;
    std::size_t free_bytes = 0;
    std::vector<RecordView> records;
  };

  struct IndexView {
    Key key{};
    std::uint32_t segment = no_segment;
    std::size_t slot = 0;
    std::uint64_t version = 0;
  };

  struct CleaningView {
    bool active = false;
    CleanMode mode = CleanMode::None;
    std::uint32_t victim = no_segment;
    std::uint32_t destination = no_segment;
    std::size_t cursor = 0;
    std::size_t candidate_count = 0;
    std::size_t copied_bytes = 0;
    std::size_t skipped_bytes = 0;
  };

  struct Dump {
    SegmentStoreConfig config;
    std::size_t capacity_bytes = 0;
    std::size_t used_bytes = 0;
    std::size_t free_bytes = 0;
    std::size_t reserved_bytes = 0;
    std::uint64_t version = 0;
    std::uint64_t reclaimed_bytes = 0;
    std::vector<SegmentView> segments;
    std::vector<IndexView> index;
    CleaningView cleaning;
  };

  explicit SegmentStore(SegmentStoreConfig config) : config_(config) {
    if (config_.segment_capacity == 0 || config_.segment_count == 0) {
      throw std::invalid_argument(
          "SegmentStore capacity and segment count must be non-zero");
    }
    if (config_.segment_count >
        std::numeric_limits<std::size_t>::max() / config_.segment_capacity) {
      throw std::invalid_argument("SegmentStore capacity overflows size_t");
    }
    if (config_.segment_count >
        static_cast<std::size_t>(no_segment)) {
      throw std::invalid_argument("SegmentStore has too many segments");
    }
    segments_.resize(config_.segment_count);
    for (std::uint32_t i = 0; i < segments_.size(); ++i) {
      segments_[i].id = i;
    }
  }

  SegmentStore(const SegmentStore& other) {
    std::lock_guard<std::mutex> lock(other.mutex_);
    config_ = other.config_;
    segments_ = other.segments_;
    index_ = other.index_;
    version_counter_ = other.version_counter_;
    reclaimed_total_ = other.reclaimed_total_;
    clean_ = other.clean_;
  }

  SegmentStore& operator=(const SegmentStore& other) {
    if (this == &other) {
      return *this;
    }
    std::scoped_lock lock(mutex_, other.mutex_);
    config_ = other.config_;
    segments_ = other.segments_;
    index_ = other.index_;
    version_counter_ = other.version_counter_;
    reclaimed_total_ = other.reclaimed_total_;
    clean_ = other.clean_;
    return *this;
  }

  SegmentStore(SegmentStore&&) = delete;
  SegmentStore& operator=(SegmentStore&&) = delete;

  // Appends a new version of key. bytes is the complete physical footprint of
  // the record (header plus payload), so byte accounting is exact and
  // independent of the host ABI.
  bool put(const Key& key, const Value& value, std::size_t bytes) {
    std::lock_guard<std::mutex> lock(mutex_);
    return append_locked(key, std::optional<Value>(value), bytes);
  }

  // Appends a tombstone. Tombstones participate in cleaning so a stale value
  // can never be resurrected by relocating an older segment.
  bool erase(const Key& key, std::size_t bytes = 1) {
    std::lock_guard<std::mutex> lock(mutex_);
    return append_locked(key, std::nullopt, bytes);
  }

  std::optional<Value> get(const Key& key) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = index_.find(key);
    if (it == index_.end()) {
      return std::nullopt;
    }
    return record_at_locked(it->second).value;
  }

  bool contains(const Key& key) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = index_.find(key);
    return it != index_.end() && record_at_locked(it->second).value.has_value();
  }

  std::size_t size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::size_t result = 0;
    for (const auto& entry : index_) {
      if (record_at_locked(entry.second).value.has_value()) {
        ++result;
      }
    }
    return result;
  }

  bool cleaning_active() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return clean_.active;
  }

  StoreStats stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return stats_locked();
  }

  Dump dump() const {
    std::lock_guard<std::mutex> lock(mutex_);
    Dump out;
    out.config = config_;
    out.capacity_bytes = total_capacity_locked();
    out.version = version_counter_;
    out.reclaimed_bytes = reclaimed_total_;
    out.segments.reserve(segments_.size());
    for (const Segment& segment : segments_) {
      SegmentView view;
      view.id = segment.id;
      view.state = segment.state;
      view.capacity_bytes = config_.segment_capacity;
      view.used_bytes = segment.used;
      view.reserved_bytes = segment.reserved;
      view.free_bytes = config_.segment_capacity - segment.used;
      view.records.reserve(segment.records.size());
      for (const Record& record : segment.records) {
        view.records.push_back(
            RecordView{record.key, record.value, record.version, record.bytes});
      }
      out.used_bytes += segment.used;
      out.reserved_bytes += segment.reserved;
      out.segments.push_back(std::move(view));
    }
    out.free_bytes = out.capacity_bytes - out.used_bytes;
    out.index.reserve(index_.size());
    for (const auto& entry : index_) {
      const SlotRef& ref = entry.second;
      out.index.push_back(IndexView{entry.first, ref.segment, ref.slot,
                                    record_at_locked(ref).version});
    }
    out.cleaning.active = clean_.active;
    out.cleaning.mode = clean_.mode;
    out.cleaning.victim = clean_.victim;
    out.cleaning.destination = clean_.dest;
    out.cleaning.cursor = clean_.cursor;
    out.cleaning.candidate_count = clean_.candidates.size();
    out.cleaning.copied_bytes = clean_.copied_bytes;
    out.cleaning.skipped_bytes = clean_.skipped_bytes;
    return out;
  }

  // Starts a cleaning session for a specific segment. Returns false when the
  // segment is not a legal victim or another session is already active.
  bool begin_clean(std::uint32_t victim) {
    std::lock_guard<std::mutex> lock(mutex_);
    return begin_clean_locked(std::optional<std::uint32_t>(victim));
  }

  // Chooses the sealed victim with the most garbage. If no sealed segment is
  // dirty, an active dirty segment is compacted in place. Returns false when no
  // useful victim exists or a session is already active.
  bool begin_clean() {
    std::lock_guard<std::mutex> lock(mutex_);
    return begin_clean_locked(std::nullopt);
  }

  // Performs one bounded cleaning action. New writers may run between calls.
  // A record is copied only after re-validating, under the store lock, that the
  // index still refers to that exact slot.
  CleanStepResult clean_step() {
    std::lock_guard<std::mutex> lock(mutex_);
    return clean_step_locked();
  }

  // Runs the active session to completion. Each step re-acquires the lock, so
  // concurrent appends interleave with the cleaning work.
  bool run_clean() {
    for (;;) {
      const CleanStepResult result = clean_step();
      if (result == CleanStepResult::Finished ||
          result == CleanStepResult::Idle) {
        return true;
      }
      if (result == CleanStepResult::NoSpace) {
        return false;
      }
    }
  }

  // Independent local check of all structural and accounting invariants. The
  // model-checking tests additionally compare every segment with a naive
  // last-write-wins recomputation.
  bool check_invariants(std::string* why = nullptr) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return check_invariants_locked(why);
  }

  std::uint64_t reclaimed_bytes() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return reclaimed_total_;
  }

 private:
  struct Record {
    Key key;
    std::optional<Value> value;
    std::uint64_t version = 0;
    std::size_t bytes = 0;
  };

  struct Segment {
    std::uint32_t id = 0;
    SegmentState state = SegmentState::Free;
    std::size_t used = 0;
    std::size_t reserved = 0;
    std::vector<Record> records;
  };

  struct SlotRef {
    std::uint32_t segment = no_segment;
    std::size_t slot = 0;
  };

  struct Candidate {
    std::size_t slot = 0;
    Key key{};
    std::uint64_t version = 0;
    std::size_t bytes = 0;
  };

  struct CleanState {
    bool active = false;
    CleanMode mode = CleanMode::None;
    std::uint32_t victim = no_segment;
    std::uint32_t dest = no_segment;
    std::size_t victim_used = 0;
    std::vector<Candidate> candidates;
    std::size_t cursor = 0;
    std::size_t copied_bytes = 0;
    std::size_t skipped_bytes = 0;
  };

  const Record& record_at_locked(const SlotRef& ref) const {
    return segments_[ref.segment].records[ref.slot];
  }

  std::size_t total_capacity_locked() const {
    return config_.segment_capacity * config_.segment_count;
  }

  std::uint32_t find_free_segment_locked() const {
    for (const Segment& segment : segments_) {
      if (segment.state == SegmentState::Free) {
        return segment.id;
      }
    }
    return no_segment;
  }

  std::uint32_t find_append_segment_locked(std::size_t bytes) {
    for (Segment& segment : segments_) {
      if (segment.state != SegmentState::Active) {
        continue;
      }
      if (segment.used + segment.reserved <= config_.segment_capacity &&
          bytes <= config_.segment_capacity - segment.used - segment.reserved) {
        return segment.id;
      }
    }
    const std::uint32_t free_id = find_free_segment_locked();
    if (free_id != no_segment) {
      segments_[free_id].state = SegmentState::Active;
      return free_id;
    }
    return no_segment;
  }

  bool append_locked(const Key& key, std::optional<Value> value,
                     std::size_t bytes) {
    if (bytes == 0 || bytes > config_.segment_capacity) {
      return false;
    }
    const std::uint32_t id = find_append_segment_locked(bytes);
    if (id == no_segment) {
      return false;
    }
    Segment& segment = segments_[id];
    const std::size_t slot = segment.records.size();
    segment.records.push_back(
        Record{key, std::move(value), ++version_counter_, bytes});
    segment.used += bytes;
    index_[key] = SlotRef{segment.id, slot};
    if (segment.used == config_.segment_capacity) {
      segment.state = SegmentState::Sealed;
    }
    return true;
  }

  std::vector<std::size_t> live_bytes_per_segment_locked() const {
    std::vector<std::size_t> live(segments_.size(), 0);
    for (const auto& entry : index_) {
      const SlotRef& ref = entry.second;
      live[ref.segment] += record_at_locked(ref).bytes;
    }
    return live;
  }

  bool begin_clean_locked(std::optional<std::uint32_t> requested) {
    if (clean_.active) {
      return false;
    }
    const std::vector<std::size_t> live = live_bytes_per_segment_locked();

    std::uint32_t victim = no_segment;
    if (requested.has_value()) {
      if (*requested >= segments_.size()) {
        return false;
      }
      const Segment& segment = segments_[*requested];
      if (segment.state == SegmentState::Free ||
          segment.state == SegmentState::Cleaning) {
        return false;
      }
      const std::size_t dead = segment.used - live[*requested];
      if (segment.used != 0 && dead == 0) {
        return false;
      }
      victim = *requested;
    } else {
      std::size_t best_dead = 0;
      for (const Segment& segment : segments_) {
        if (segment.state != SegmentState::Sealed) {
          continue;
        }
        const std::size_t dead = segment.used - live[segment.id];
        if (dead > best_dead) {
          best_dead = dead;
          victim = segment.id;
        }
      }
      if (victim == no_segment) {
        for (const Segment& segment : segments_) {
          if (segment.state != SegmentState::Active) {
            continue;
          }
          const std::size_t dead = segment.used - live[segment.id];
          if (dead > best_dead) {
            best_dead = dead;
            victim = segment.id;
          }
        }
      }
      if (victim == no_segment) {
        return false;
      }
    }

    Segment& victim_segment = segments_[victim];
    if (victim_segment.used == 0) {
      victim_segment.state = SegmentState::Free;
      victim_segment.reserved = 0;
      victim_segment.records.clear();
      return true;
    }

    const std::size_t victim_live = live[victim];
    if (victim_live == 0) {
      reclaimed_total_ += victim_segment.used;
      victim_segment.used = 0;
      victim_segment.reserved = 0;
      victim_segment.state = SegmentState::Free;
      victim_segment.records.clear();
      return true;
    }

    CleanState next;
    next.active = true;
    next.victim = victim;
    next.victim_used = victim_segment.used;

    if (victim_segment.state == SegmentState::Sealed) {
      const std::uint32_t dest = find_free_segment_locked();
      if (dest != no_segment) {
        next.mode = CleanMode::Relocate;
        next.dest = dest;
        Segment& destination = segments_[dest];
        destination.state = SegmentState::Active;
        destination.reserved = victim_live;
        next.candidates.reserve(victim_segment.records.size());
        for (std::size_t slot = 0;
             slot < victim_segment.records.size(); ++slot) {
          const Record& record = victim_segment.records[slot];
          const auto it = index_.find(record.key);
          if (it != index_.end() && it->second.segment == victim &&
              it->second.slot == slot) {
            next.candidates.push_back(
                Candidate{slot, record.key, record.version, record.bytes});
          }
        }
      }
    }

    if (next.mode == CleanMode::None) {
      next.mode = CleanMode::InPlace;
    }
    victim_segment.state = SegmentState::Cleaning;
    clean_ = std::move(next);
    return true;
  }

  void release_reservation_locked(std::size_t bytes) {
    if (clean_.dest == no_segment) {
      return;
    }
    Segment& destination = segments_[clean_.dest];
    destination.reserved =
        destination.reserved >= bytes ? destination.reserved - bytes : 0;
  }

  void finish_relocate_locked() {
    Segment& victim = segments_[clean_.victim];
    Segment& destination = segments_[clean_.dest];
    if (clean_.victim_used > clean_.copied_bytes) {
      reclaimed_total_ += clean_.victim_used - clean_.copied_bytes;
    }
    victim.used = 0;
    victim.reserved = 0;
    victim.records.clear();
    victim.state = SegmentState::Free;

    destination.reserved = 0;
    if (destination.used == 0) {
      destination.state = SegmentState::Free;
    } else if (destination.used == config_.segment_capacity) {
      destination.state = SegmentState::Sealed;
    } else {
      destination.state = SegmentState::Active;
    }
    clean_ = CleanState{};
  }

  void finish_in_place_locked() {
    Segment& victim = segments_[clean_.victim];
    const std::size_t old_used = victim.used;
    std::vector<Record> kept;
    kept.reserve(victim.records.size());
    for (std::size_t slot = 0; slot < victim.records.size(); ++slot) {
      const Record& record = victim.records[slot];
      const auto it = index_.find(record.key);
      if (it != index_.end() && it->second.segment == clean_.victim &&
          it->second.slot == slot) {
        it->second.slot = kept.size();
        kept.push_back(std::move(victim.records[slot]));
      }
    }
    std::size_t new_used = 0;
    for (const Record& record : kept) {
      new_used += record.bytes;
    }
    victim.records = std::move(kept);
    victim.used = new_used;
    victim.reserved = 0;
    if (new_used == config_.segment_capacity) {
      victim.state = SegmentState::Sealed;
    } else {
      // An in-place pass reclaims dead bytes; reopening a formerly sealed
      // segment lets writers use the reclaimed tail instead of deadlocking at
      // the capacity limit.
      victim.state = SegmentState::Active;
    }
    if (old_used > new_used) {
      reclaimed_total_ += old_used - new_used;
    }
    clean_ = CleanState{};
  }

  CleanStepResult clean_step_locked() {
    if (!clean_.active) {
      return CleanStepResult::Idle;
    }
    if (clean_.mode == CleanMode::InPlace) {
      finish_in_place_locked();
      return CleanStepResult::Finished;
    }
    if (clean_.cursor >= clean_.candidates.size()) {
      finish_relocate_locked();
      return CleanStepResult::Finished;
    }

    const Candidate candidate = clean_.candidates[clean_.cursor];
    const auto it = index_.find(candidate.key);
    const bool still_live =
        it != index_.end() && it->second.segment == clean_.victim &&
        it->second.slot == candidate.slot;
    if (!still_live) {
      release_reservation_locked(candidate.bytes);
      clean_.skipped_bytes += candidate.bytes;
      ++clean_.cursor;
      return CleanStepResult::Skipped;
    }

    Segment& victim = segments_[clean_.victim];
    Segment& destination = segments_[clean_.dest];
    const Record& source = victim.records[candidate.slot];
    if (source.version != candidate.version ||
        source.bytes != candidate.bytes ||
        destination.reserved < candidate.bytes ||
        destination.used > config_.segment_capacity - candidate.bytes) {
      return CleanStepResult::NoSpace;
    }

    const std::size_t slot = destination.records.size();
    destination.records.push_back(source);
    destination.used += candidate.bytes;
    destination.reserved -= candidate.bytes;
    index_[candidate.key] = SlotRef{destination.id, slot};
    clean_.copied_bytes += candidate.bytes;
    ++clean_.cursor;

    if (clean_.cursor == clean_.candidates.size()) {
      finish_relocate_locked();
      return CleanStepResult::Finished;
    }
    return CleanStepResult::Copied;
  }

  StoreStats stats_locked() const {
    StoreStats out;
    out.segment_count = config_.segment_count;
    out.segment_capacity = config_.segment_capacity;
    out.capacity_bytes = total_capacity_locked();
    out.version = version_counter_;
    out.reclaimed_bytes = reclaimed_total_;
    out.cleaning_active = clean_.active;

    std::vector<std::size_t> live_per_segment(segments_.size(), 0);
    std::vector<std::size_t> live_count_per_segment(segments_.size(), 0);
    for (const auto& entry : index_) {
      const SlotRef& ref = entry.second;
      const Record& record = record_at_locked(ref);
      live_per_segment[ref.segment] += record.bytes;
      ++live_count_per_segment[ref.segment];
      out.live_bytes += record.bytes;
      if (record.value.has_value()) {
        out.live_user_bytes += record.bytes;
      } else {
        out.live_tombstone_bytes += record.bytes;
      }
      ++out.live_record_count;
    }

    out.segments.reserve(segments_.size());
    for (const Segment& segment : segments_) {
      SegmentStats view;
      view.id = segment.id;
      view.state = segment.state;
      view.capacity_bytes = config_.segment_capacity;
      view.used_bytes = segment.used;
      view.reserved_bytes = segment.reserved;
      view.free_bytes = config_.segment_capacity - segment.used;
      view.live_bytes = live_per_segment[segment.id];
      view.dead_bytes = segment.used - view.live_bytes;
      view.record_count = segment.records.size();
      view.live_record_count = live_count_per_segment[segment.id];
      for (const Record& record : segment.records) {
        if (!record.value.has_value()) {
          ++out.tombstone_record_count;
        }
      }
      out.used_bytes += segment.used;
      out.reserved_bytes += segment.reserved;
      out.record_count += segment.records.size();
      out.segments.push_back(view);
    }
    out.free_bytes = out.capacity_bytes - out.used_bytes;
    out.available_bytes = out.free_bytes - out.reserved_bytes;
    out.dead_bytes = out.used_bytes - out.live_bytes;
    return out;
  }

  bool check_invariants_locked(std::string* why) const {
    const auto fail = [why](std::string message) {
      if (why != nullptr) {
        *why = std::move(message);
      }
      return false;
    };

    if (segments_.size() != config_.segment_count) {
      return fail("segment count mismatch");
    }

    std::size_t total_used = 0;
    std::size_t total_reserved = 0;
    for (std::uint32_t id = 0; id < segments_.size(); ++id) {
      const Segment& segment = segments_[id];
      if (segment.id != id) {
        return fail("segment id mismatch");
      }
      if (segment.used > config_.segment_capacity) {
        return fail("segment used exceeds capacity");
      }
      if (segment.reserved > config_.segment_capacity - segment.used) {
        return fail("segment reservation exceeds free bytes");
      }
      std::size_t sum = 0;
      for (const Record& record : segment.records) {
        if (record.bytes == 0 || record.bytes > config_.segment_capacity) {
          return fail("record footprint out of range");
        }
        if (record.version == 0) {
          return fail("record has zero version");
        }
        sum += record.bytes;
      }
      if (sum != segment.used) {
        return fail("segment used does not equal record bytes");
      }
      if (segment.state == SegmentState::Free &&
          (segment.used != 0 || segment.reserved != 0 ||
           !segment.records.empty())) {
        return fail("free segment is not empty");
      }
      total_used += segment.used;
      total_reserved += segment.reserved;
    }
    if (total_used + total_reserved > total_capacity_locked()) {
      return fail("reserved plus used exceeds total capacity");
    }

    struct MaxVersion {
      std::uint64_t version = 0;
      SlotRef ref{};
    };
    std::unordered_map<Key, MaxVersion, Hash, KeyEqual> max_version;
    max_version.reserve(index_.size());
    for (const Segment& segment : segments_) {
      for (std::size_t slot = 0; slot < segment.records.size(); ++slot) {
        const Record& record = segment.records[slot];
        auto [it, inserted] = max_version.try_emplace(
            record.key, MaxVersion{record.version, SlotRef{segment.id, slot}});
        if (!inserted && record.version > it->second.version) {
          it->second.version = record.version;
          it->second.ref = SlotRef{segment.id, slot};
        }
      }
    }

    if (max_version.size() != index_.size()) {
      return fail("index does not cover every written key");
    }
    for (const auto& entry : index_) {
      const SlotRef& ref = entry.second;
      if (ref.segment >= segments_.size()) {
        return fail("index segment out of range");
      }
      if (ref.slot >= segments_[ref.segment].records.size()) {
        return fail("index slot out of range");
      }
      const Record& record = record_at_locked(ref);
      if (record.key != entry.first) {
        return fail("index key does not match referenced record");
      }
      const auto max_it = max_version.find(entry.first);
      if (max_it == max_version.end()) {
        return fail("index key has no physical record");
      }
      if (record.version != max_it->second.version) {
        return fail("index does not reference the newest version");
      }
    }
    for (const auto& entry : max_version) {
      if (index_.find(entry.first) == index_.end()) {
        return fail("physical key is missing from the index");
      }
    }

    bool victim_seen = false;
    for (const Segment& segment : segments_) {
      if (segment.state == SegmentState::Cleaning) {
        if (!clean_.active || segment.id != clean_.victim) {
          return fail("unexpected cleaning segment");
        }
        victim_seen = true;
      }
    }
    if (clean_.active) {
      if (!victim_seen || clean_.victim >= segments_.size()) {
        return fail("cleaning session has no victim in cleaning state");
      }
      if (clean_.cursor > clean_.candidates.size()) {
        return fail("cleaning cursor out of range");
      }
      if (clean_.mode == CleanMode::Relocate) {
        if (clean_.dest >= segments_.size() || clean_.dest == clean_.victim) {
          return fail("relocation destination invalid");
        }
        if (segments_[clean_.dest].state != SegmentState::Active &&
            segments_[clean_.dest].state != SegmentState::Sealed) {
          return fail("relocation destination is not a live segment");
        }
        std::size_t remaining = 0;
        for (std::size_t i = clean_.cursor; i < clean_.candidates.size(); ++i) {
          remaining += clean_.candidates[i].bytes;
        }
        if (segments_[clean_.dest].reserved != remaining) {
          return fail("destination reservation does not match candidates");
        }
        if (segments_[clean_.victim].used != clean_.victim_used) {
          return fail("relocation changed victim occupancy");
        }
      } else if (clean_.mode == CleanMode::InPlace) {
        if (clean_.dest != no_segment) {
          return fail("in-place cleaning has a destination");
        }
      } else {
        return fail("active cleaning has no mode");
      }
    } else {
      if (victim_seen) {
        return fail("cleaning state without a session");
      }
      if (clean_.mode != CleanMode::None ||
          clean_.victim != no_segment || clean_.dest != no_segment) {
        return fail("stale cleaning metadata");
      }
    }

    const StoreStats recomputed = stats_locked();
    if (recomputed.used_bytes + recomputed.free_bytes !=
        recomputed.capacity_bytes) {
      return fail("used plus free does not equal capacity");
    }
    if (recomputed.live_bytes + recomputed.dead_bytes !=
        recomputed.used_bytes) {
      return fail("live plus dead does not equal used");
    }
    if (recomputed.reserved_bytes > recomputed.free_bytes) {
      return fail("reservation exceeds aggregate free bytes");
    }
    if (recomputed.available_bytes !=
        recomputed.free_bytes - recomputed.reserved_bytes) {
      return fail("available bytes accounting mismatch");
    }
    return true;
  }

  SegmentStoreConfig config_;
  mutable std::mutex mutex_;
  std::vector<Segment> segments_;
  std::unordered_map<Key, SlotRef, Hash, KeyEqual> index_;
  std::uint64_t version_counter_ = 0;
  std::uint64_t reclaimed_total_ = 0;
  CleanState clean_;
};

}  // namespace dlks_formal
