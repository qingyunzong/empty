#include <dlks_formal.hpp>

#include "lru_model.hpp"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <future>
#include <iostream>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using dlks_formal::access_status;
using dlks_formal::page_cache;
using dlks_formal::page_cache_options;
using dlks_formal_test::lru_model;

void require_impl(bool condition, const char* expression, const char* file,
                  int line) {
  if (!condition) {
    std::cerr << file << ':' << line
              << ": requirement failed: " << expression << '\n';
    std::exit(1);
  }
}

#define REQUIRE(...) \
  require_impl(static_cast<bool>(__VA_ARGS__), #__VA_ARGS__, __FILE__, \
               __LINE__)

std::uint32_t next_random(std::uint32_t& state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

struct payload {
  std::uint64_t token = 0;
  std::uint64_t sequence = 0;
};

page_cache_options deterministic_options(std::size_t capacity) {
  page_cache_options options;
  options.capacity = capacity;
  options.lru_sample_size = 0;  // exact LRU: full scan
  options.auto_throttle = false;
  options.writeback_on_pressure = false;
  options.eviction_log_limit = 4096;
  return options;
}

void test_hit_miss_accounting() {
  auto options = deterministic_options(4);
  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) -> std::optional<int> {
        if (key == 99) {
          return std::nullopt;
        }
        return static_cast<int>(key);
      },
      [](const std::uint64_t&, const int&) { return true; });

  auto first = cache.acquire(1);
  REQUIRE(first.status == access_status::loaded);
  REQUIRE(first->value() == 1);
  first->reset();

  auto second = cache.acquire(1);
  REQUIRE(second.status == access_status::hit);
  REQUIRE(second->value() == 1);
  second->reset();

  auto missing = cache.acquire(99);
  REQUIRE(missing.status == access_status::not_found);
  REQUIRE(!missing);

  const auto stats = cache.stats();
  REQUIRE(stats.accesses == 3);
  REQUIRE(stats.hits == 1);
  REQUIRE(stats.misses == 2);
  REQUIRE(stats.loaded == 1);
  REQUIRE(stats.not_found == 1);
  REQUIRE(stats.insertions == 1);
  REQUIRE(stats.resident == 1);
  REQUIRE(stats.pinned == 0);

  std::string error;
  REQUIRE(cache.validate(&error));
}

void test_dirty_pages_are_not_reclaimed() {
  auto options = deterministic_options(3);
  std::vector<std::uint64_t> written;
  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [&written](const std::uint64_t& key, const int&) {
        written.push_back(key);
        return true;
      });

  auto page1 = cache.acquire(1);
  auto page2 = cache.acquire(2);
  auto page3 = cache.acquire(3);
  REQUIRE(page1 && page2 && page3);
  page2->mark_dirty();
  page1->reset();
  page2->reset();
  page3->reset();

  const auto first_victim = cache.reclaim(1);
  REQUIRE(first_victim.size() == 1);
  REQUIRE(first_victim[0] == 1);
  REQUIRE(cache.contains(2));
  REQUIRE(!cache.contains(1));

  const auto second_victim = cache.reclaim(1);
  REQUIRE(second_victim.size() == 1);
  REQUIRE(second_victim[0] == 3);
  REQUIRE(cache.contains(2));

  REQUIRE(cache.reclaim(1).empty());
  REQUIRE(cache.dirty_count() == 1);

  REQUIRE(cache.writeback(1) == 1);
  REQUIRE(written == std::vector<std::uint64_t>{2});
  REQUIRE(!cache.is_dirty(2));

  const auto third_victim = cache.reclaim(1);
  REQUIRE(third_victim.size() == 1);
  REQUIRE(third_victim[0] == 2);
  REQUIRE(cache.size() == 0);

  std::string error;
  REQUIRE(cache.validate(&error));
}

void test_exact_lru_order() {
  auto options = deterministic_options(3);
  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [](const std::uint64_t&, const int&) { return true; });

  {
    auto p1 = cache.acquire(1);
    auto p2 = cache.acquire(2);
    auto p3 = cache.acquire(3);
    REQUIRE(p1 && p2 && p3);
  }

  {
    auto hit = cache.acquire(1);
    REQUIRE(hit.status == access_status::hit);
  }

  auto miss4 = cache.acquire(4);
  REQUIRE(miss4.status == access_status::loaded);
  auto evicted = cache.take_evictions();
  REQUIRE(evicted == std::vector<std::uint64_t>{2});

  {
    auto hit = cache.acquire(3);
    REQUIRE(hit.status == access_status::hit);
  }

  auto miss5 = cache.acquire(5);
  REQUIRE(miss5.status == access_status::loaded);
  evicted = cache.take_evictions();
  REQUIRE(evicted == std::vector<std::uint64_t>{1});

  REQUIRE(!cache.contains(1));
  REQUIRE(!cache.contains(2));
  REQUIRE(cache.contains(3));
  REQUIRE(cache.contains(4));
  REQUIRE(cache.contains(5));

  std::string error;
  REQUIRE(cache.validate(&error));
}

void test_writeback_throttling() {
  auto options = deterministic_options(16);
  options.dirty_high_watermark = 4;
  options.dirty_low_watermark = 2;
  options.writeback_batch = 2;

  std::vector<std::uint64_t> written;
  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [&written](const std::uint64_t& key, const int&) {
        written.push_back(key);
        return true;
      });

  for (std::uint64_t key = 0; key < 8; ++key) {
    auto page = cache.acquire(key);
    REQUIRE(page);
    page->mark_dirty();
  }

  REQUIRE(cache.dirty_count() == 8);
  const std::size_t flushed = cache.throttle();
  REQUIRE(flushed == 6);
  REQUIRE(cache.dirty_count() == 2);
  REQUIRE(written == std::vector<std::uint64_t>{0, 1, 2, 3, 4, 5});
  REQUIRE(cache.is_dirty(6));
  REQUIRE(cache.is_dirty(7));

  REQUIRE(cache.flush() == 2);
  REQUIRE(cache.dirty_count() == 0);
  REQUIRE(written == std::vector<std::uint64_t>{0, 1, 2, 3, 4, 5, 6, 7});

  std::string error;
  REQUIRE(cache.validate(&error));
}

void test_auto_throttle_from_mark_dirty() {
  auto options = deterministic_options(8);
  options.dirty_high_watermark = 2;
  options.dirty_low_watermark = 1;
  options.writeback_batch = 2;
  options.auto_throttle = true;

  std::vector<std::uint64_t> written;
  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [&written](const std::uint64_t& key, const int&) {
        written.push_back(key);
        return true;
      });

  for (std::uint64_t key = 0; key < 4; ++key) {
    auto page = cache.acquire(key);
    REQUIRE(page);
    page->mark_dirty();
    REQUIRE(cache.dirty_count() <= options.dirty_high_watermark);
  }

  REQUIRE(written == std::vector<std::uint64_t>{0, 1});
  REQUIRE(cache.is_dirty(2));
  REQUIRE(cache.is_dirty(3));

  std::string error;
  REQUIRE(cache.validate(&error));
}

void test_stale_writeback_accounting() {
  auto options = deterministic_options(4);

  std::promise<void> entered;
  std::promise<void> proceed;
  auto entered_future = entered.get_future();
  auto proceed_future = proceed.get_future();
  std::atomic<int> calls{0};
  std::mutex written_mutex;
  std::vector<std::uint64_t> written;

  page_cache<payload> cache(
      options,
      [](const std::uint64_t&) { return std::optional<payload>(payload{}); },
      [&](const std::uint64_t& key, const payload&) {
        const int call = ++calls;
        if (call == 1) {
          entered.set_value();
          proceed_future.wait();
        }
        std::lock_guard<std::mutex> lock(written_mutex);
        written.push_back(key);
        return true;
      });

  auto page = cache.acquire(7);
  REQUIRE(page);
  page->value().token = 1;
  page->mark_dirty();

  std::thread writer([&cache] {
    const std::size_t count = cache.writeback(1);
    REQUIRE(count == 1);
  });

  entered_future.wait();
  page->value().token = 2;
  page->mark_dirty();
  proceed.set_value();
  writer.join();

  auto stats = cache.stats();
  REQUIRE(stats.writeback_requests == 1);
  REQUIRE(stats.writebacks_completed == 1);
  REQUIRE(stats.writebacks_stale == 1);
  REQUIRE(stats.writebacks_cleaned == 0);
  REQUIRE(stats.dirty == 1);
  REQUIRE(stats.dirty_transitions == 1);
  REQUIRE(stats.writeback_inflight == 0);

  std::string error;
  REQUIRE(cache.validate(&error));

  REQUIRE(cache.writeback(1) == 1);
  stats = cache.stats();
  REQUIRE(stats.writebacks_completed == 2);
  REQUIRE(stats.writebacks_cleaned == 1);
  REQUIRE(stats.writebacks_stale == 1);
  REQUIRE(stats.dirty == 0);
  REQUIRE(cache.validate(&error));
  REQUIRE(written == std::vector<std::uint64_t>{7, 7});

  page->reset();
}

void test_writeback_failure_keeps_page_dirty() {
  auto options = deterministic_options(2);
  bool fail = true;
  std::atomic<int> calls{0};

  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [&](const std::uint64_t&, const int&) {
        ++calls;
        return !fail;
      });

  auto page = cache.acquire(5);
  REQUIRE(page);
  page->mark_dirty();
  page->reset();

  REQUIRE(cache.writeback(1) == 0);
  auto stats = cache.stats();
  REQUIRE(stats.writeback_requests == 1);
  REQUIRE(stats.writeback_failures == 1);
  REQUIRE(stats.writebacks_completed == 0);
  REQUIRE(stats.dirty == 1);
  REQUIRE(cache.is_dirty(5));

  std::string error;
  REQUIRE(cache.validate(&error));

  fail = false;
  REQUIRE(cache.writeback(1) == 1);
  stats = cache.stats();
  REQUIRE(stats.writeback_requests == 2);
  REQUIRE(stats.writeback_failures == 1);
  REQUIRE(stats.writebacks_completed == 1);
  REQUIRE(stats.writebacks_cleaned == 1);
  REQUIRE(stats.dirty == 0);
  REQUIRE(calls.load() == 2);
  REQUIRE(cache.validate(&error));

  const auto victims = cache.reclaim(1);
  REQUIRE(victims == std::vector<std::uint64_t>{5});
}

void test_pinned_page_survives_writeback_and_reclaim() {
  auto options = deterministic_options(4);

  std::promise<void> entered;
  std::promise<void> proceed;
  auto entered_future = entered.get_future();
  auto proceed_future = proceed.get_future();

  page_cache<payload> cache(
      options,
      [](const std::uint64_t&) { return std::optional<payload>(payload{}); },
      [&](const std::uint64_t& key, const payload&) {
        if (key == 7) {
          entered.set_value();
          proceed_future.wait();
        }
        return true;
      });

  auto pinned = cache.acquire(7);
  REQUIRE(pinned);
  pinned->value().token = 0xABCDEF;
  pinned->mark_dirty();

  {
    auto p1 = cache.acquire(1);
    auto p2 = cache.acquire(2);
    auto p3 = cache.acquire(3);
    REQUIRE(p1 && p2 && p3);
  }

  std::thread writer([&cache] {
    const std::size_t count = cache.writeback(4);
    REQUIRE(count == 1);
  });

  entered_future.wait();

  const auto during_writeback = cache.reclaim(10);
  REQUIRE(during_writeback.size() == 3);
  REQUIRE(cache.contains(7));
  REQUIRE(pinned->value().token == 0xABCDEF);

  proceed.set_value();
  writer.join();

  const auto after_writeback = cache.reclaim(10);
  REQUIRE(after_writeback.empty());
  REQUIRE(cache.contains(7));
  REQUIRE(pinned->value().token == 0xABCDEF);

  pinned->reset();
  const auto after_unpin = cache.reclaim(10);
  REQUIRE(after_unpin == std::vector<std::uint64_t>{7});
  REQUIRE(!cache.contains(7));

  std::string error;
  REQUIRE(cache.validate(&error));
}

void test_handle_move_semantics() {
  auto options = deterministic_options(4);
  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [](const std::uint64_t&, const int&) { return true; });

  auto first_result = cache.acquire(1);
  REQUIRE(first_result);
  auto first = std::move(*first_result);
  REQUIRE(cache.pinned_count() == 1);

  auto moved = std::move(first);
  REQUIRE(!first);
  REQUIRE(moved);
  REQUIRE(cache.pinned_count() == 1);

  auto second_result = cache.acquire(2);
  REQUIRE(second_result);
  auto second = std::move(*second_result);
  REQUIRE(cache.pinned_count() == 2);

  moved = std::move(second);
  REQUIRE(cache.pinned_count() == 1);
  REQUIRE(cache.contains(1));

  moved.mark_dirty();
  REQUIRE(moved.dirty());
  moved.reset();
  REQUIRE(cache.pinned_count() == 0);

  std::string error;
  REQUIRE(cache.validate(&error));
}

void test_option_validation() {
  bool threw = false;
  try {
    page_cache<int> bad(page_cache_options{.capacity = 0});
    (void)bad;
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  REQUIRE(threw);

  threw = false;
  try {
    page_cache<int> bad(page_cache_options{
        .capacity = 4,
        .dirty_high_watermark = 2,
        .dirty_low_watermark = 3,
    });
    (void)bad;
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  REQUIRE(threw);

  page_cache<int> small(page_cache_options{.capacity = 2});
  REQUIRE(small.options().dirty_high_watermark == 1);
  REQUIRE(small.options().dirty_low_watermark == 1);
}

void test_generic_string_keys() {
  auto options = deterministic_options(2);
  page_cache<int, std::string> cache(
      options,
      [](const std::string& key) {
        return std::optional<int>(static_cast<int>(key.size()));
      },
      [](const std::string&, const int&) { return true; });

  auto alpha = cache.acquire("alpha");
  REQUIRE(alpha);
  REQUIRE(alpha->key() == "alpha");
  REQUIRE(alpha->value() == 5);
  alpha->mark_dirty();
  alpha->reset();

  auto brave = cache.acquire("bravo");
  REQUIRE(brave);
  REQUIRE(brave->value() == 5);
  brave->reset();

  const auto victims = cache.reclaim(1);
  REQUIRE(victims.size() == 1);
  REQUIRE(victims[0] == "bravo");
  REQUIRE(cache.contains("alpha"));

  std::string error;
  REQUIRE(cache.validate(&error));
}

void compare_cache_and_model(page_cache<int>& cache, lru_model& model,
                             const std::vector<std::uint64_t>& cache_written,
                             std::size_t key_space) {
  REQUIRE(cache.size() == model.size());
  REQUIRE(cache.dirty_count() == model.dirty_count());

  for (std::uint64_t key = 0; key < key_space; ++key) {
    REQUIRE(cache.contains(key) == model.contains(key));
    REQUIRE(cache.is_dirty(key) == model.is_dirty(key));
  }

  const auto cache_evictions = cache.take_evictions();
  const auto model_evictions = model.take_evictions();
  REQUIRE(cache_evictions == model_evictions);

  const auto model_written = model.take_written();
  REQUIRE(cache_written == model_written);

  const auto stats = cache.stats();
  REQUIRE(stats.accesses == model.accesses());
  REQUIRE(stats.hits == model.hits());
  REQUIRE(stats.misses == model.misses());
  REQUIRE(stats.insertions == model.insertions());
  REQUIRE(stats.evictions == model.evictions());
  REQUIRE(stats.dirty_transitions == model.dirty_transitions());
  REQUIRE(stats.no_space == model.no_space());
  REQUIRE(stats.writebacks_completed == model.writebacks());
  REQUIRE(stats.writebacks_cleaned == model.writebacks());
  REQUIRE(stats.writebacks_stale == 0);
  REQUIRE(stats.writeback_failures == 0);
  REQUIRE(stats.resident == model.size());
  REQUIRE(stats.dirty == model.dirty_count());
  REQUIRE(stats.pinned == 0);

  std::string error;
  REQUIRE(cache.validate(&error));
}

void test_differential_against_naive_lru() {
  constexpr std::uint64_t key_space = 12;
  auto options = deterministic_options(5);

  std::vector<std::uint64_t> cache_written;
  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [&cache_written](const std::uint64_t& key, const int&) {
        cache_written.push_back(key);
        return true;
      });
  lru_model model(options.capacity);

  std::uint32_t random = 0xC0FFEEu;
  for (std::size_t step = 0; step < 20000; ++step) {
    const std::uint32_t operation = next_random(random) % 10;
    if (operation < 6) {
      const std::uint64_t key = next_random(random) % key_space;
      auto cache_result = cache.acquire(key);
      const auto model_result = model.access(key);

      switch (cache_result.status) {
        case access_status::hit:
          REQUIRE(model_result.kind == lru_model::access_kind::hit);
          break;
        case access_status::loaded:
          REQUIRE(model_result.kind == lru_model::access_kind::inserted);
          break;
        case access_status::no_space:
          REQUIRE(model_result.kind == lru_model::access_kind::no_space);
          break;
        default:
          REQUIRE(false);
      }

      if (cache_result) {
        model.pin(key);
        if (next_random(random) % 3 == 0) {
          cache_result->mark_dirty();
          model.mark_dirty(key);
        }
        cache_result->reset();
        model.unpin(key);
      }
    } else if (operation < 8) {
      const std::size_t limit = next_random(random) % 4;
      const std::size_t cache_count = cache.writeback(limit);
      const std::size_t model_count = model.writeback(limit);
      REQUIRE(cache_count == model_count);
    } else {
      const std::size_t want = next_random(random) % 4;
      const auto cache_victims = cache.reclaim(want);
      const auto model_victims = model.reclaim(want);
      REQUIRE(cache_victims == model_victims);
    }

    compare_cache_and_model(cache, model, cache_written, key_space);
    cache_written.clear();
  }
}

void test_sampled_lru_invariants() {
  auto options = deterministic_options(16);
  options.lru_sample_size = 2;
  options.auto_throttle = false;

  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [](const std::uint64_t&, const int&) { return true; });

  constexpr std::uint64_t key_space = 32;
  std::vector<bool> pinned(key_space, false);
  std::uint32_t random = 0x12345678u;

  for (std::size_t step = 0; step < 5000; ++step) {
    const std::uint32_t operation = next_random(random) % 10;
    if (operation < 6) {
      const std::uint64_t key = next_random(random) % key_space;
      auto page = cache.acquire(key);
      if (page) {
        pinned[key] = true;
        if (next_random(random) % 4 == 0) {
          page->mark_dirty();
        }
        page->reset();
        pinned[key] = false;
      }
    } else if (operation < 8) {
      const std::size_t limit = next_random(random) % 4;
      (void)cache.writeback(limit);
    } else {
      std::set<std::uint64_t> dirty_before;
      for (std::uint64_t key = 0; key < key_space; ++key) {
        if (cache.is_dirty(key)) {
          dirty_before.insert(key);
        }
      }

      const auto victims = cache.reclaim(next_random(random) % 4);
      for (std::uint64_t victim : victims) {
        REQUIRE(!pinned[victim]);
        REQUIRE(dirty_before.find(victim) == dirty_before.end());
      }
    }

    REQUIRE(cache.size() <= cache.capacity());
    std::string error;
    REQUIRE(cache.validate(&error));
  }
}

void test_concurrent_hits_reclaim_and_writeback() {
  auto options = deterministic_options(8);
  options.auto_throttle = false;
  options.writeback_on_pressure = false;

  std::atomic<std::uint64_t> writebacks{0};
  page_cache<int> cache(
      options,
      [](const std::uint64_t& key) { return std::optional<int>(int(key)); },
      [&writebacks](const std::uint64_t&, const int&) {
        writebacks.fetch_add(1, std::memory_order_relaxed);
        return true;
      });

  constexpr std::uint64_t key_space = 32;
  std::vector<std::thread> threads;
  threads.reserve(6);

  for (std::uint32_t worker = 0; worker < 4; ++worker) {
    threads.emplace_back([&cache, worker] {
      std::uint32_t random = 0x9E3779B9u ^ (worker * 0x85EBCA6Bu);
      for (std::size_t step = 0; step < 3000; ++step) {
        const std::uint64_t key = next_random(random) % key_space;
        auto page = cache.acquire(key);
        if (page) {
          REQUIRE(page->value() == static_cast<int>(key));
          if (next_random(random) % 5 == 0) {
            page->mark_dirty();
          }
          if (next_random(random) % 7 == 0) {
            std::this_thread::yield();
          }
        }
      }
    });
  }

  for (std::uint32_t worker = 0; worker < 2; ++worker) {
    threads.emplace_back([&cache, worker] {
      std::uint32_t random = 0x27D4EB2Fu ^ (worker * 0x165667B1u);
      for (std::size_t step = 0; step < 3000; ++step) {
        if (next_random(random) % 2 == 0) {
          (void)cache.reclaim(1);
        } else {
          (void)cache.writeback(2);
        }
        std::this_thread::yield();
      }
    });
  }

  for (auto& thread : threads) {
    thread.join();
  }

  (void)cache.flush();
  const auto stats = cache.stats();
  REQUIRE(stats.accesses == stats.hits + stats.misses);
  REQUIRE(stats.pinned == 0);
  REQUIRE(writebacks.load() == stats.writebacks_completed);
  REQUIRE(stats.resident <= options.capacity);

  std::string error;
  REQUIRE(cache.validate(&error));
}

}  // namespace

int main() {
  test_hit_miss_accounting();
  test_dirty_pages_are_not_reclaimed();
  test_exact_lru_order();
  test_writeback_throttling();
  test_auto_throttle_from_mark_dirty();
  test_stale_writeback_accounting();
  test_writeback_failure_keeps_page_dirty();
  test_pinned_page_survives_writeback_and_reclaim();
  test_handle_move_semantics();
  test_option_validation();
  test_generic_string_keys();
  test_differential_against_naive_lru();
  test_sampled_lru_invariants();
  test_concurrent_hits_reclaim_and_writeback();

  std::cout << "all page_cache tests passed\n";
  return 0;
}
