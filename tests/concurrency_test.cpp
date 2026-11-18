#include "dlks_formal.hpp"
#include "model.hpp"
#include "test_framework.hpp"

#include <atomic>
#include <cstddef>
#include <map>
#include <thread>
#include <vector>

namespace {

using Store = dlks_formal::SegmentStore<int, int>;
using Model = dlks_test::NaiveModel<int, int>;

}  // namespace

DLKS_TEST(concurrent_writers_and_stepwise_cleaner_preserve_latest_values) {
  constexpr int kWriterCount = 3;
  constexpr int kIterations = 800;
  constexpr int kKeysPerWriter = 3;
  constexpr std::size_t kFootprint = 8;

  Store store({64, 4});
  std::atomic<int> ready{0};
  std::atomic<bool> start{false};
  std::atomic<int> done{0};
  std::atomic<int> failures{0};
  std::vector<std::map<int, int>> expected(kWriterCount);

  std::vector<std::thread> writers;
  writers.reserve(kWriterCount);
  for (int writer = 0; writer < kWriterCount; ++writer) {
    writers.emplace_back([&, writer] {
      ready.fetch_add(1);
      while (!start.load()) {
        std::this_thread::yield();
      }
      int value = 0;
      for (int iteration = 0; iteration < kIterations;) {
        const int key = writer * 1000 + (iteration % kKeysPerWriter);
        ++value;
        if (store.put(key, value, kFootprint)) {
          expected[writer][key] = value;
          ++iteration;
        } else {
          std::this_thread::yield();
        }
      }
      done.fetch_add(1);
    });
  }

  std::thread cleaner([&] {
    ready.fetch_add(1);
    while (!start.load()) {
      std::this_thread::yield();
    }
    while (done.load() < kWriterCount) {
      if (!store.begin_clean()) {
        std::this_thread::yield();
        continue;
      }
      for (;;) {
        const auto result = store.clean_step();
        if (result == dlks_formal::CleanStepResult::Finished ||
            result == dlks_formal::CleanStepResult::Idle) {
          break;
        }
        if (result == dlks_formal::CleanStepResult::NoSpace) {
          failures.fetch_add(1);
          break;
        }
        std::this_thread::yield();
      }
    }
  });

  while (ready.load() < kWriterCount + 1) {
    std::this_thread::yield();
  }
  start.store(true);
  for (auto& writer : writers) {
    writer.join();
  }
  cleaner.join();

  CHECK_EQ(failures.load(), 0);
  CHECK(!store.cleaning_active());
  Model model;
  for (const auto& rows : expected) {
    for (const auto& row : rows) {
      model.put(row.first, row.second);
      CHECK_EQ(store.get(row.first).value(), row.second);
    }
  }
  dlks_test::verify_store_against_model(store, model, "concurrent stress");

  const auto stats = store.stats();
  CHECK(stats.reclaimed_bytes > 0);
  CHECK_EQ(stats.used_bytes + stats.free_bytes, stats.capacity_bytes);
  CHECK_EQ(stats.live_bytes + stats.dead_bytes, stats.used_bytes);
}
