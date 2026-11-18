#pragma once

// dlks_formal: an embeddable, fixed-capacity page cache for storage layers.
//
// The cache is header-only and dependency-free.  It owns a fixed number of
// page frames and never grows its frame array.  Page payloads and the backing
// store are supplied through callbacks, so the component can sit in front of a
// block device, a memory-mapped file, a simulator, or another storage layer.
//
// Replacement policy
// -----------------
// Victim selection is sampled LRU.  Every hit advances a logical clock and each
// frame records its last access.  A reclaim scans at most `lru_sample_size`
// resident frames starting at a rotating hand and picks the least recently used
// clean, unpinned frame in that window.  If the window contains no eligible
// frame, the scan falls back to the whole frame array so a reclaim is never
// stalled merely because the sample was unlucky.  Setting `lru_sample_size` to
// zero (or to at least `capacity`) makes victim selection exact LRU over the
// eligible set.  This is useful for deterministic reference-model tests.
//
// Dirty-page policy
// -----------------
// A dirty page is never selected for reclaim.  It becomes eligible only after a
// successful writeback has observed the latest dirty version.  Writebacks take
// a snapshot while holding the metadata lock and invoke the user callback after
// releasing it.  If a page is modified while its writeback is in flight, the
// completion is counted as stale and the page remains dirty.
//
// Concurrency
// -----------
// All metadata is protected by one mutex.  `acquire()` returns a move-only
// handle that pins the frame; a pinned frame cannot be reclaimed.  Loader and
// writer callbacks are always invoked without the cache mutex held.  A frame
// with a writeback in flight is also protected from reclaim.
//
// Counter conservation
// --------------------
// `page_cache::validate()` checks the accounting invariants, including:
//   accesses == hits + misses
//   misses   == loaded + coalesced + not_found + load_errors + no_space
//   resident == insertions - evictions
//   dirty_transitions == writebacks_cleaned + dirty_resident
//   writeback_requests == completed + failed + in_flight
//   completed == cleaned + stale
//
// The last two invariants make hit and writeback accounting exact even when a
// page is re-dirtied while an earlier writeback is still in flight.

#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dlks_formal {

enum class access_status {
  hit,        //!< The page was already resident.
  loaded,     //!< The loader supplied the page and it was inserted.
  coalesced,  //!< A concurrent miss inserted the page while the loader ran.
  not_found,  //!< The loader reported that the page does not exist.
  no_space,   //!< The loader supplied a page, but no frame could be freed.
  load_error  //!< The loader threw.  The exception is rethrown to the caller.
};

struct page_cache_options {
  //! Number of page frames.  Must be greater than zero.
  std::size_t capacity = 64;

  //! Number of resident frames inspected by one reclaim sample.
  //! Zero (or a value >= capacity) means a full scan, i.e. exact LRU among
  //! clean, unpinned pages.
  std::size_t lru_sample_size = 32;

  //! Dirty-page high watermark.  `throttle()` starts when dirty pages exceed it.
  //! It is clamped to at most `capacity - 1` so automatic throttling remains
  //! reachable when only `capacity` is overridden.
  std::size_t dirty_high_watermark = 24;

  //! Dirty-page low watermark.  `throttle()` stops at or below this value.
  //! It is clamped to the normalized high watermark.
  std::size_t dirty_low_watermark = 12;

  //! Maximum writebacks performed by one `throttle()` or pressure-reclaim pass.
  std::size_t writeback_batch = 8;

  //! If true, `acquire()` and `handle::mark_dirty()` trigger throttling.
  bool auto_throttle = true;

  //! If true, an acquisition that cannot find a free frame may write back
  //! dirty pages once and retry.
  bool writeback_on_pressure = true;

  //! Maximum number of key records retained for `take_evictions()`.
  //! Set to zero to disable the diagnostic eviction log.
  std::size_t eviction_log_limit = 1024;
};

struct page_cache_stats {
  std::uint64_t accesses = 0;
  std::uint64_t hits = 0;
  std::uint64_t misses = 0;

  std::uint64_t loaded = 0;
  std::uint64_t coalesced = 0;
  std::uint64_t not_found = 0;
  std::uint64_t load_errors = 0;
  std::uint64_t no_space = 0;

  std::uint64_t load_successes = 0;
  std::uint64_t discarded_loads = 0;

  std::uint64_t insertions = 0;
  std::uint64_t evictions = 0;

  std::uint64_t dirty_transitions = 0;

  std::uint64_t writeback_requests = 0;
  std::uint64_t writebacks_completed = 0;
  std::uint64_t writebacks_cleaned = 0;
  std::uint64_t writebacks_stale = 0;
  std::uint64_t writeback_failures = 0;

  std::size_t resident = 0;
  std::size_t dirty = 0;
  std::size_t pinned = 0;
  std::size_t writeback_inflight = 0;
};

//! Fixed-capacity page cache.
//!
//! `Value` must be copy-constructible because a writeback takes a snapshot that
//! can be handed to the backing-store callback after the metadata lock is
//! released.  `Key` must be hashable and equality-comparable.
template <class Value, class Key = std::uint64_t, class Hash = std::hash<Key>,
          class KeyEqual = std::equal_to<Key>>
class page_cache {
  static_assert(std::is_copy_constructible_v<Value>,
                "page_cache<Value> requires Value to be copy-constructible "
                "for writeback snapshots");
 public:
  using key_type = Key;
  using value_type = Value;
  using loader_type = std::function<std::optional<Value>(const Key&)>;
  using writer_type = std::function<bool(const Key&, const Value&)>;

 private:
  enum class slot_state : unsigned char { empty, resident };

  struct slot {
    slot_state state = slot_state::empty;
    std::optional<Key> key;
    std::optional<Value> value;
    std::uint64_t generation = 0;
    std::uint64_t last_access = 0;
    std::uint64_t dirty_sequence = 0;
    std::uint64_t dirty_version = 0;
    std::uint32_t pins = 0;
    bool dirty = false;
    bool writeback_inflight = false;
    std::uint64_t writeback_version = 0;
  };

  struct writeback_request {
    std::size_t index = 0;
    Key key;
    Value snapshot;
    std::uint64_t generation = 0;
    std::uint64_t version = 0;

    writeback_request(std::size_t index_, const Key& key_, const Value& value_,
                      std::uint64_t generation_, std::uint64_t version_)
        : index(index_),
          key(key_),
          snapshot(value_),
          generation(generation_),
          version(version_) {}
  };

 public:
  class handle {
   public:
    handle() noexcept = default;

    handle(const handle&) = delete;
    handle& operator=(const handle&) = delete;

    handle(handle&& other) noexcept
        : cache_(std::exchange(other.cache_, nullptr)),
          index_(other.index_),
          generation_(other.generation_) {}

    handle& operator=(handle&& other) noexcept {
      if (this != &other) {
        release();
        cache_ = std::exchange(other.cache_, nullptr);
        index_ = other.index_;
        generation_ = other.generation_;
      }
      return *this;
    }

    ~handle() { release(); }

    [[nodiscard]] explicit operator bool() const noexcept {
      return cache_ != nullptr;
    }

    [[nodiscard]] const Key& key() const noexcept {
      assert(cache_ != nullptr && "dereferencing an empty page handle");
      return *cache_->slots_[index_].key;
    }

    [[nodiscard]] Value& value() {
      assert(cache_ != nullptr && "dereferencing an empty page handle");
      return *cache_->slots_[index_].value;
    }

    [[nodiscard]] const Value& value() const {
      assert(cache_ != nullptr && "dereferencing an empty page handle");
      return *cache_->slots_[index_].value;
    }

    //! Refresh the page's LRU timestamp.  Hits already do this automatically;
    //! a long-lived pin may call it to record continued use.
    void touch() {
      if (cache_ != nullptr) {
        cache_->touch_slot(index_, generation_);
      }
    }

    //! Mark the page dirty.  Re-marking an already dirty page advances its
    //! dirty version, so an in-flight writeback that raced with this change is
    //! reported as stale rather than accidentally cleaning the page.
    void mark_dirty() {
      if (cache_ != nullptr) {
        cache_->mark_dirty_slot(index_, generation_);
      }
    }

    [[nodiscard]] bool dirty() const {
      return cache_ != nullptr &&
             cache_->slot_is_dirty(index_, generation_);
    }

    void reset() noexcept { release(); }

   private:
    friend class page_cache;

    handle(page_cache* cache, std::size_t index,
           std::uint64_t generation) noexcept
        : cache_(cache), index_(index), generation_(generation) {}

    void release() noexcept {
      if (cache_ != nullptr) {
        page_cache* cache = std::exchange(cache_, nullptr);
        cache->unpin_slot(index_, generation_);
      }
    }

    page_cache* cache_ = nullptr;
    std::size_t index_ = 0;
    std::uint64_t generation_ = 0;
  };

  struct access_result {
    access_status status = access_status::not_found;
    std::optional<handle> page;

    access_result() = default;
    explicit access_result(access_status status_) : status(status_) {}
    access_result(access_status status_, handle page_)
        : status(status_), page(std::move(page_)) {}

    [[nodiscard]] explicit operator bool() const noexcept {
      return page.has_value();
    }

    [[nodiscard]] handle& operator*() noexcept { return *page; }
    [[nodiscard]] const handle& operator*() const noexcept { return *page; }
    [[nodiscard]] handle* operator->() noexcept { return &*page; }
    [[nodiscard]] const handle* operator->() const noexcept { return &*page; }
  };

  explicit page_cache(page_cache_options options, loader_type loader = {},
                      writer_type writer = {})
      : options_(normalize_options(options)),
        loader_(std::move(loader)),
        writer_(std::move(writer)),
        slots_(options_.capacity) {
    free_slots_.reserve(options_.capacity);
    for (std::size_t i = options_.capacity; i > 0; --i) {
      free_slots_.push_back(i - 1);
    }
    index_.reserve(options_.capacity * 2 + 1);
  }

  page_cache(const page_cache&) = delete;
  page_cache& operator=(const page_cache&) = delete;
  page_cache(page_cache&&) = delete;
  page_cache& operator=(page_cache&&) = delete;

  ~page_cache() {
    // Handles must not outlive the cache.  This assertion catches the common
    // mistake in debug builds without imposing overhead in release builds.
    assert(pinned_total_ == 0 && "page handles outlived their page_cache");
  }

  //! Acquire a page, loading it on a miss and pinning it until the returned
  //! handle is destroyed or reset.
  [[nodiscard]] access_result acquire(const Key& key) {
    if (options_.auto_throttle) {
      throttle();
    }

    std::unique_lock<std::mutex> lock(mutex_);
    ++stats_.accesses;

    if (auto it = index_.find(key); it != index_.end()) {
      ++stats_.hits;
      slot& frame = slots_[it->second];
      touch_locked(frame);
      pin_locked(frame);
      return access_result{access_status::hit,
                           handle(this, it->second, frame.generation)};
    }

    ++stats_.misses;
    lock.unlock();

    std::optional<Value> loaded;
    try {
      if (loader_) {
        loaded = loader_(key);
      }
    } catch (...) {
      std::lock_guard<std::mutex> guard(mutex_);
      ++stats_.load_errors;
      throw;
    }

    lock.lock();

    // The loader deliberately runs unlocked, so another thread may have
    // installed the page while it was in flight.
    if (auto it = index_.find(key); it != index_.end()) {
      ++stats_.coalesced;
      if (loaded.has_value()) {
        ++stats_.load_successes;
      }
      slot& frame = slots_[it->second];
      touch_locked(frame);
      pin_locked(frame);
      return access_result{access_status::coalesced,
                           handle(this, it->second, frame.generation)};
    }

    if (!loaded.has_value()) {
      ++stats_.not_found;
      return access_result{access_status::not_found};
    }

    ++stats_.load_successes;
    const std::size_t max_pressure_rounds =
        options_.capacity / options_.writeback_batch + 2;
    std::size_t pressure_rounds = 0;
    for (;;) {
      if (auto index = allocate_slot_locked(); index.has_value()) {
        const std::size_t slot_index = *index;
        try {
          insert_locked(slot_index, key, std::move(*loaded));
        } catch (...) {
          ++stats_.discarded_loads;
          ++stats_.no_space;
          return access_result{access_status::no_space};
        }
        return access_result{
            access_status::loaded,
            handle(this, slot_index, slots_[slot_index].generation)};
      }

      std::size_t written = 0;
      if (options_.writeback_on_pressure && dirty_ > 0 &&
          pressure_rounds < max_pressure_rounds) {
        ++pressure_rounds;
        lock.unlock();
        written = writeback(options_.writeback_batch);
        lock.lock();

        // Another thread may have installed the page while writeback ran.
        if (auto it = index_.find(key); it != index_.end()) {
          ++stats_.coalesced;
          slot& frame = slots_[it->second];
          touch_locked(frame);
          pin_locked(frame);
          return access_result{
              access_status::coalesced,
              handle(this, it->second, frame.generation)};
        }
      }

      if (written == 0) {
        ++stats_.discarded_loads;
        ++stats_.no_space;
        return access_result{access_status::no_space};
      }
    }
  }

  //! Evict up to `want` clean, unpinned pages.  Dirty and writeback-in-flight
  //! pages are skipped.  Returns the keys in eviction order.
  [[nodiscard]] std::vector<Key> reclaim(std::size_t want = 1) {
    std::vector<Key> evicted;
    if (want == 0) {
      return evicted;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    evicted.reserve(std::min(want, resident_));
    for (std::size_t i = 0; i < want; ++i) {
      auto victim = select_victim_locked();
      if (!victim.has_value()) {
        break;
      }
      evicted.push_back(*slots_[*victim].key);
      evict_locked(*victim);
    }
    return evicted;
  }

  //! Write back up to `max_pages` dirty pages, oldest dirty episode first.
  //! Returns the number of successful writer callbacks.
  std::size_t writeback(std::size_t max_pages =
                            (std::numeric_limits<std::size_t>::max)()) {
    std::size_t successful = 0;
    const std::size_t attempts = std::min(max_pages, slots_.size());

    for (std::size_t i = 0; i < attempts; ++i) {
      std::optional<writeback_request> request;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        auto candidate = select_dirty_locked();
        if (!candidate.has_value()) {
          break;
        }

        slot& frame = slots_[*candidate];
        try {
          request.emplace(*candidate, *frame.key, *frame.value,
                          frame.generation, frame.dirty_version);
        } catch (...) {
          ++stats_.writeback_requests;
          ++stats_.writeback_failures;
          break;
        }

        frame.writeback_inflight = true;
        frame.writeback_version = frame.dirty_version;
        ++stats_.writeback_requests;
        ++stats_.writeback_inflight;
        ++inflight_;
      }

      bool ok = true;
      try {
        if (writer_) {
          ok = writer_(request->key, request->snapshot);
        }
      } catch (...) {
        ok = false;
      }

      {
        std::lock_guard<std::mutex> lock(mutex_);
        assert(inflight_ > 0);
        --inflight_;
        assert(stats_.writeback_inflight > 0);
        --stats_.writeback_inflight;

        slot& frame = slots_[request->index];
        if (frame.state == slot_state::resident &&
            frame.generation == request->generation) {
          frame.writeback_inflight = false;
          if (!ok) {
            ++stats_.writeback_failures;
          } else {
            ++stats_.writebacks_completed;
            if (frame.dirty_version == request->version) {
              if (frame.dirty) {
                frame.dirty = false;
                --dirty_;
              }
              ++stats_.writebacks_cleaned;
            } else {
              ++stats_.writebacks_stale;
            }
          }
        } else {
          // A frame in writeback is never selected for reclaim, so this can
          // only happen after an invariant violation.
          ++stats_.writeback_failures;
        }
      }

      if (ok) {
        ++successful;
      } else {
        // Stop the batch on an I/O error.  The page stays dirty and a later
        // call can retry it without this call spinning on the same failure.
        break;
      }
    }
    return successful;
  }

  //! Apply dirty-page throttling.  Starts only when dirty pages exceed the high
  //! watermark and writes back batches until the low watermark is reached.
  std::size_t throttle() {
    std::size_t successful = 0;
    const std::size_t batch = options_.writeback_batch;
    const std::size_t rounds = options_.capacity / batch + 2;

    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (dirty_ <= options_.dirty_high_watermark) {
        return 0;
      }
    }

    for (std::size_t round = 0; round < rounds; ++round) {
      const std::size_t written = writeback(batch);
      successful += written;
      if (written == 0) {
        break;
      }

      std::lock_guard<std::mutex> lock(mutex_);
      if (dirty_ <= options_.dirty_low_watermark) {
        break;
      }
    }
    return successful;
  }

  //! Write back all currently dirty pages.  Concurrently re-dirtied pages may
  //! remain dirty when this returns.
  std::size_t flush() {
    std::size_t total = 0;
    const std::size_t rounds = slots_.size() + 1;
    for (std::size_t i = 0; i < rounds; ++i) {
      if (dirty_count() == 0) {
        break;
      }
      const std::size_t written = writeback(options_.writeback_batch);
      total += written;
      if (written == 0) {
        break;
      }
    }
    return total;
  }

  [[nodiscard]] bool contains(const Key& key) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return index_.find(key) != index_.end();
  }

  [[nodiscard]] bool is_dirty(const Key& key) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = index_.find(key);
    return it != index_.end() && slots_[it->second].dirty;
  }

  [[nodiscard]] std::size_t capacity() const noexcept {
    return slots_.size();
  }

  [[nodiscard]] std::size_t size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return resident_;
  }

  [[nodiscard]] std::size_t dirty_count() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return dirty_;
  }

  [[nodiscard]] std::size_t pinned_count() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return pinned_total_;
  }

  [[nodiscard]] page_cache_stats stats() const {
    std::lock_guard<std::mutex> lock(mutex_);
    page_cache_stats result = stats_;
    result.resident = resident_;
    result.dirty = dirty_;
    result.pinned = pinned_total_;
    result.writeback_inflight = inflight_;
    return result;
  }

  //! Return and clear the keys evicted since the previous call.
  [[nodiscard]] std::vector<Key> take_evictions() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<Key> result;
    result.reserve(recent_evictions_.size());
    result.assign(recent_evictions_.begin(), recent_evictions_.end());
    recent_evictions_.clear();
    return result;
  }

  //! Check the structural and accounting invariants.  This is intended for
  //! tests and debugging; it takes the metadata lock and scans all frames.
  [[nodiscard]] bool validate(std::string* error = nullptr) const {
    std::lock_guard<std::mutex> lock(mutex_);

    auto fail = [error](const char* message) {
      if (error != nullptr) {
        *error = message;
      }
      return false;
    };

    if (stats_.accesses != stats_.hits + stats_.misses) {
      return fail("accesses != hits + misses");
    }
    if (stats_.misses != stats_.loaded + stats_.coalesced +
                              stats_.not_found + stats_.load_errors +
                              stats_.no_space) {
      return fail("miss outcome counters do not sum to misses");
    }
    if (stats_.insertions != stats_.loaded) {
      return fail("insertions != loaded");
    }
    if (stats_.insertions < stats_.evictions ||
        resident_ != stats_.insertions - stats_.evictions) {
      return fail("resident != insertions - evictions");
    }
    if (dirty_ > resident_) {
      return fail("dirty pages exceed resident pages");
    }
    if (stats_.dirty_transitions !=
        stats_.writebacks_cleaned + static_cast<std::uint64_t>(dirty_)) {
      return fail("dirty transitions != cleaned writebacks + dirty pages");
    }
    if (stats_.writeback_requests !=
        stats_.writebacks_completed + stats_.writeback_failures +
            static_cast<std::uint64_t>(inflight_)) {
      return fail("writeback requests != completions + failures + in flight");
    }
    if (stats_.writebacks_completed !=
        stats_.writebacks_cleaned + stats_.writebacks_stale) {
      return fail("completed writebacks != cleaned + stale");
    }
    if (free_slots_.size() + resident_ != slots_.size()) {
      return fail("free slots + resident != capacity");
    }
    if (hand_ >= slots_.size()) {
      return fail("clock hand out of range");
    }

    std::size_t resident = 0;
    std::size_t dirty = 0;
    std::size_t pinned = 0;
    std::size_t inflight = 0;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
      const slot& frame = slots_[i];
      if (frame.state == slot_state::empty) {
        if (frame.pins != 0 || frame.dirty || frame.writeback_inflight ||
            frame.value.has_value()) {
          return fail("empty frame carries state");
        }
        continue;
      }

      ++resident;
      if (!frame.key.has_value() || !frame.value.has_value()) {
        return fail("resident frame lacks key or value");
      }
      auto it = index_.find(*frame.key);
      if (it == index_.end() || it->second != i) {
        return fail("resident frame is not indexed to itself");
      }
      if (frame.pins != 0) {
        pinned += frame.pins;
      }
      if (frame.dirty) {
        ++dirty;
      }
      if (frame.writeback_inflight) {
        ++inflight;
      }
    }

    if (resident != resident_) {
      return fail("resident counter mismatch");
    }
    if (dirty != dirty_) {
      return fail("dirty counter mismatch");
    }
    if (pinned != pinned_total_) {
      return fail("pin counter mismatch");
    }
    if (inflight != inflight_) {
      return fail("in-flight writeback counter mismatch");
    }
    if (index_.size() != resident_) {
      return fail("index size mismatch");
    }
    return true;
  }

  [[nodiscard]] const page_cache_options& options() const noexcept {
    return options_;
  }

 private:
  static page_cache_options normalize_options(page_cache_options options) {
    if (options.capacity == 0) {
      throw std::invalid_argument("page_cache capacity must be non-zero");
    }
    if (options.writeback_batch == 0) {
      throw std::invalid_argument("writeback batch must be non-zero");
    }
    if (options.dirty_low_watermark > options.dirty_high_watermark) {
      throw std::invalid_argument(
          "dirty low watermark must not exceed high watermark");
    }
    // Leaving room for at least one dirty transition makes the automatic
    // throttle reachable even when a caller only overrides `capacity`.
    const std::size_t maximum_high =
        options.capacity > 1 ? options.capacity - 1 : 0;
    options.dirty_high_watermark =
        std::min(options.dirty_high_watermark, maximum_high);
    options.dirty_low_watermark =
        std::min(options.dirty_low_watermark, options.dirty_high_watermark);
    return options;
  }

  [[nodiscard]] std::size_t scan_window_locked() const noexcept {
    if (options_.lru_sample_size == 0 ||
        options_.lru_sample_size >= slots_.size()) {
      return slots_.size();
    }
    return options_.lru_sample_size;
  }

  void touch_locked(slot& frame) noexcept {
    if (tick_ == (std::numeric_limits<std::uint64_t>::max)()) {
      // Extremely long-running caches: halve all timestamps while preserving
      // order.  Exact ties are harmless because the hand still advances.
      tick_ >>= 1;
      dirty_tick_ >>= 1;
      for (slot& candidate : slots_) {
        candidate.last_access >>= 1;
        candidate.dirty_sequence >>= 1;
      }
    }
    frame.last_access = ++tick_;
  }

  void pin_locked(slot& frame) noexcept {
    ++frame.pins;
    ++pinned_total_;
  }

  void unpin_slot(std::size_t index, std::uint64_t generation) noexcept {
    try {
      std::lock_guard<std::mutex> lock(mutex_);
      if (index >= slots_.size()) {
        return;
      }
      slot& frame = slots_[index];
      if (frame.state == slot_state::resident &&
          frame.generation == generation) {
        if (frame.pins > 0) {
          --frame.pins;
        }
        if (pinned_total_ > 0) {
          --pinned_total_;
        }
      }
    } catch (...) {
      // Destructors must not throw.
    }
  }

  void touch_slot(std::size_t index, std::uint64_t generation) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (index >= slots_.size()) {
      return;
    }
    slot& frame = slots_[index];
    if (frame.state == slot_state::resident &&
        frame.generation == generation) {
      touch_locked(frame);
    }
  }

  void mark_dirty_slot(std::size_t index, std::uint64_t generation) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (index >= slots_.size()) {
        return;
      }
      slot& frame = slots_[index];
      if (frame.state != slot_state::resident ||
          frame.generation != generation) {
        return;
      }

      if (!frame.dirty) {
        frame.dirty = true;
        frame.dirty_sequence = ++dirty_tick_;
        ++dirty_;
        ++stats_.dirty_transitions;
      }
      ++frame.dirty_version;
    }

    if (options_.auto_throttle) {
      throttle();
    }
  }

  [[nodiscard]] bool slot_is_dirty(std::size_t index,
                                   std::uint64_t generation) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (index >= slots_.size()) {
      return false;
    }
    const slot& frame = slots_[index];
    return frame.state == slot_state::resident &&
           frame.generation == generation && frame.dirty;
  }

  [[nodiscard]] std::optional<std::size_t> allocate_slot_locked() {
    if (!free_slots_.empty()) {
      const std::size_t index = free_slots_.back();
      free_slots_.pop_back();
      return index;
    }
    auto victim = select_victim_locked();
    if (!victim.has_value()) {
      return std::nullopt;
    }
    evict_locked(*victim, false);
    return victim;
  }

  [[nodiscard]] std::optional<std::size_t> select_victim_locked() {
    if (resident_ == 0) {
      return std::nullopt;
    }

    const std::size_t window = scan_window_locked();
    std::size_t best = k_no_slot;
    std::size_t inspected = 0;
    std::size_t position = hand_;

    for (std::size_t step = 0;
         step < slots_.size() && inspected < window; ++step) {
      const std::size_t index = position;
      position = (position + 1) % slots_.size();
      const slot& frame = slots_[index];
      if (frame.state != slot_state::resident) {
        continue;
      }
      ++inspected;
      if (!eligible_for_reclaim(frame)) {
        continue;
      }
      if (best == k_no_slot ||
          frame.last_access < slots_[best].last_access) {
        best = index;
      }
    }

    if (best == k_no_slot) {
      // A small sample must not make reclaim fail while an eligible page is
      // just outside the window.  Fall back to a full scan.
      std::size_t fallback = hand_;
      for (std::size_t step = 0; step < slots_.size(); ++step) {
        const std::size_t index = fallback;
        fallback = (fallback + 1) % slots_.size();
        const slot& frame = slots_[index];
        if (frame.state != slot_state::resident ||
            !eligible_for_reclaim(frame)) {
          continue;
        }
        if (best == k_no_slot ||
            frame.last_access < slots_[best].last_access) {
          best = index;
        }
      }
      position = fallback;
    }

    if (best != k_no_slot) {
      hand_ = (best + 1) % slots_.size();
      return best;
    }

    hand_ = position % slots_.size();
    return std::nullopt;
  }

  [[nodiscard]] static bool eligible_for_reclaim(const slot& frame) noexcept {
    return frame.state == slot_state::resident && frame.pins == 0 &&
           !frame.dirty && !frame.writeback_inflight;
  }

  [[nodiscard]] std::optional<std::size_t> select_dirty_locked() const {
    std::size_t best = k_no_slot;
    for (std::size_t i = 0; i < slots_.size(); ++i) {
      const slot& frame = slots_[i];
      if (frame.state != slot_state::resident || !frame.dirty ||
          frame.writeback_inflight) {
        continue;
      }
      if (best == k_no_slot ||
          frame.dirty_sequence < slots_[best].dirty_sequence) {
        best = i;
      }
    }
    if (best == k_no_slot) {
      return std::nullopt;
    }
    return best;
  }

  void insert_locked(std::size_t index, const Key& key, Value&& value) {
    slot& frame = slots_[index];
    assert(frame.state == slot_state::empty);

    try {
      frame.key.emplace(key);
      frame.value.emplace(std::move(value));
      auto [position, inserted] = index_.emplace(*frame.key, index);
      (void)position;
      if (!inserted) {
        throw std::logic_error("duplicate page key during insertion");
      }
    } catch (...) {
      frame.state = slot_state::empty;
      frame.key.reset();
      frame.value.reset();
      frame.pins = 0;
      frame.dirty = false;
      frame.writeback_inflight = false;
      free_slots_.push_back(index);
      throw;
    }

    frame.state = slot_state::resident;
    frame.generation = ++generation_counter_;
    touch_locked(frame);
    frame.dirty = false;
    frame.dirty_sequence = 0;
    frame.dirty_version = 0;
    frame.pins = 1;
    frame.writeback_inflight = false;
    frame.writeback_version = 0;

    ++resident_;
    ++pinned_total_;
    ++stats_.insertions;
    ++stats_.loaded;
  }

  void evict_locked(std::size_t index, bool recycle = true) {
    slot& frame = slots_[index];
    assert(eligible_for_reclaim(frame));
    assert(frame.key.has_value());

    Key victim = std::move(*frame.key);
    index_.erase(victim);

    frame.state = slot_state::empty;
    frame.key.reset();
    frame.value.reset();
    frame.generation = 0;
    frame.last_access = 0;
    frame.dirty_sequence = 0;
    frame.dirty_version = 0;
    frame.pins = 0;
    frame.dirty = false;
    frame.writeback_inflight = false;
    frame.writeback_version = 0;

    --resident_;
    ++stats_.evictions;
    if (recycle) {
      free_slots_.push_back(index);
    }

    if (options_.eviction_log_limit != 0) {
      try {
        if (recent_evictions_.size() == options_.eviction_log_limit) {
          recent_evictions_.pop_front();
        }
        recent_evictions_.push_back(victim);
      } catch (...) {
        // The eviction log is diagnostic; never fail an eviction because the
        // diagnostic buffer could not grow.
      }
    }
  }

  static constexpr std::size_t k_no_slot =
      (std::numeric_limits<std::size_t>::max)();

  page_cache_options options_;
  loader_type loader_;
  writer_type writer_;

  mutable std::mutex mutex_;
  std::vector<slot> slots_;
  std::vector<std::size_t> free_slots_;
  std::unordered_map<Key, std::size_t, Hash, KeyEqual> index_;

  std::size_t hand_ = 0;
  std::size_t resident_ = 0;
  std::size_t dirty_ = 0;
  std::size_t pinned_total_ = 0;
  std::size_t inflight_ = 0;
  std::uint64_t tick_ = 0;
  std::uint64_t dirty_tick_ = 0;
  std::uint64_t generation_counter_ = 0;

  page_cache_stats stats_;
  std::deque<Key> recent_evictions_;
};

}  // namespace dlks_formal
