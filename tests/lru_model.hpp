#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dlks_formal_test {

// A deliberately naive, single-threaded LRU model.  It exists only to provide
// an independent oracle for deterministic traces:
//
//   * hits refresh recency;
//   * a miss evicts the least recently used clean, unpinned page;
//   * dirty pages are never evicted;
//   * writeback selects the oldest dirty episode first.
//
// The cache under test is configured with `lru_sample_size == 0` while this
// model is active, which makes the cache's sampled scan cover the whole frame
// array and therefore select exactly the same victim.
class lru_model {
 public:
  using key_type = std::uint64_t;

  enum class access_kind { hit, inserted, no_space };

  struct access_result {
    access_kind kind = access_kind::no_space;
  };

  explicit lru_model(std::size_t capacity) : capacity_(capacity) {}

  access_result access(key_type key) {
    ++tick_;
    ++accesses_;

    if (auto it = pages_.find(key); it != pages_.end()) {
      ++hits_;
      it->second.last_use = tick_;
      return {access_kind::hit};
    }

    if (pages_.size() == capacity_ && !evict_one()) {
      ++no_space_;
      return {access_kind::no_space};
    }

    pages_.emplace(key, entry{tick_, 0, false, 0});
    ++insertions_;
    return {access_kind::inserted};
  }

  void pin(key_type key) { ++pages_.at(key).pins; }

  void unpin(key_type key) {
    auto it = pages_.find(key);
    if (it != pages_.end() && it->second.pins > 0) {
      --it->second.pins;
    }
  }

  void mark_dirty(key_type key) {
    auto it = pages_.find(key);
    if (it == pages_.end()) {
      return;
    }
    entry& page = it->second;
    if (!page.dirty) {
      page.dirty = true;
      page.dirty_sequence = ++dirty_tick_;
      ++dirty_transitions_;
    }
  }

  std::size_t writeback(std::size_t max_pages) {
    std::vector<std::pair<std::uint64_t, key_type>> candidates;
    for (const auto& [key, page] : pages_) {
      if (page.dirty) {
        candidates.emplace_back(page.dirty_sequence, key);
      }
    }
    std::sort(candidates.begin(), candidates.end());

    std::size_t count = 0;
    for (const auto& [sequence, key] : candidates) {
      (void)sequence;
      if (count == max_pages) {
        break;
      }
      entry& page = pages_.at(key);
      page.dirty = false;
      ++writebacks_;
      written_.push_back(key);
      ++count;
    }
    return count;
  }

  std::vector<key_type> reclaim(std::size_t want) {
    std::vector<key_type> victims;
    victims.reserve(std::min(want, pages_.size()));
    for (std::size_t i = 0; i < want; ++i) {
      auto victim = find_lru_clean_unpinned();
      if (victim == pages_.end()) {
        break;
      }
      victims.push_back(victim->first);
      evictions_.push_back(victim->first);
      ++evictions_total_;
      pages_.erase(victim);
    }
    return victims;
  }

  [[nodiscard]] bool contains(key_type key) const {
    return pages_.find(key) != pages_.end();
  }

  [[nodiscard]] bool is_dirty(key_type key) const {
    auto it = pages_.find(key);
    return it != pages_.end() && it->second.dirty;
  }

  [[nodiscard]] std::size_t size() const noexcept { return pages_.size(); }

  [[nodiscard]] std::size_t dirty_count() const {
    std::size_t count = 0;
    for (const auto& [key, page] : pages_) {
      (void)key;
      if (page.dirty) {
        ++count;
      }
    }
    return count;
  }

  [[nodiscard]] std::uint64_t accesses() const noexcept { return accesses_; }
  [[nodiscard]] std::uint64_t hits() const noexcept { return hits_; }
  [[nodiscard]] std::uint64_t misses() const noexcept {
    return accesses_ - hits_;
  }
  [[nodiscard]] std::uint64_t insertions() const noexcept {
    return insertions_;
  }
  [[nodiscard]] std::uint64_t evictions() const noexcept {
    return evictions_total_;
  }
  [[nodiscard]] std::uint64_t dirty_transitions() const noexcept {
    return dirty_transitions_;
  }
  [[nodiscard]] std::uint64_t writebacks() const noexcept {
    return writebacks_;
  }
  [[nodiscard]] std::uint64_t no_space() const noexcept { return no_space_; }

  [[nodiscard]] std::vector<key_type> take_evictions() {
    std::vector<key_type> result;
    result.swap(evictions_);
    return result;
  }

  [[nodiscard]] std::vector<key_type> take_written() {
    std::vector<key_type> result;
    result.swap(written_);
    return result;
  }

 private:
  struct entry {
    std::uint64_t last_use = 0;
    std::uint64_t dirty_sequence = 0;
    bool dirty = false;
    std::size_t pins = 0;
  };

  using page_map = std::unordered_map<key_type, entry>;

  [[nodiscard]] page_map::iterator find_lru_clean_unpinned() {
    auto best = pages_.end();
    for (auto it = pages_.begin(); it != pages_.end(); ++it) {
      if (it->second.pins != 0 || it->second.dirty) {
        continue;
      }
      if (best == pages_.end() ||
          it->second.last_use < best->second.last_use) {
        best = it;
      }
    }
    return best;
  }

  bool evict_one() {
    auto victim = find_lru_clean_unpinned();
    if (victim == pages_.end()) {
      return false;
    }
    evictions_.push_back(victim->first);
    ++evictions_total_;
    pages_.erase(victim);
    return true;
  }

  std::size_t capacity_;
  page_map pages_;
  std::uint64_t tick_ = 0;
  std::uint64_t dirty_tick_ = 0;
  std::uint64_t accesses_ = 0;
  std::uint64_t hits_ = 0;
  std::uint64_t insertions_ = 0;
  std::uint64_t dirty_transitions_ = 0;
  std::uint64_t writebacks_ = 0;
  std::uint64_t no_space_ = 0;
  std::uint64_t evictions_total_ = 0;
  std::vector<key_type> evictions_;
  std::vector<key_type> written_;
};

}  // namespace dlks_formal_test
