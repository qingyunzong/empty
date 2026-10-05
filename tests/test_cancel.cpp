// Cancellation: a cancelled reduction returns no value and releases all
// internal buffers before returning.
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <optional>
#include <thread>

#include "check.hpp"
#include "xreduce/bigint.hpp"
#include "xreduce/reduce.hpp"

using xreduce::BigInt;
using xreduce::BufferTracker;
using xreduce::CancelToken;
using xreduce::ReduceOptions;

int main() {
  const std::size_t n = 200000;

  // 1) Cancel before start: returns immediately with no value.
  {
    CancelToken token;
    BufferTracker tracker;
    token.cancel();
    auto map = [](std::size_t i) -> std::optional<BigInt> {
      return BigInt(static_cast<long long>(i));
    };
    auto add = [](const BigInt &a, const BigInt &b) { return a + b; };
    auto out = xreduce::parallel_reduce<BigInt>(n, map, add,
                                                ReduceOptions{64, 4}, &token,
                                                &tracker);
    CHECK(!out.value.has_value());
    CHECK(out.cancelled);
    CHECK(!out.failed_block.has_value());
    CHECK(tracker.live() == 0);
  }

  // 2) Cancel mid-run from another thread: workers block inside map until
  //    the main thread cancels and releases them.
  {
    CancelToken token;
    BufferTracker tracker;
    std::atomic<bool> release{false};
    std::atomic<std::size_t> started{0};

    auto map = [&](std::size_t i) -> std::optional<BigInt> {
      started.fetch_add(1, std::memory_order_relaxed);
      while (!release.load(std::memory_order_acquire))
        std::this_thread::yield();
      return BigInt(static_cast<long long>(i));
    };
    auto add = [](const BigInt &a, const BigInt &b) { return a + b; };

    auto fut = std::async(std::launch::async, [&] {
      return xreduce::parallel_reduce<BigInt>(n, map, add,
                                              ReduceOptions{32, 4}, &token,
                                              &tracker);
    });

    // Wait until workers are inside the reduction, then cancel.
    while (started.load(std::memory_order_relaxed) == 0)
      std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    token.cancel();
    release.store(true, std::memory_order_release);

    auto out = fut.get();
    CHECK(!out.value.has_value());
    CHECK(out.cancelled);
    CHECK(!out.failed_block.has_value());
    CHECK(tracker.live() == 0); // every buffer released
  }

  std::cout << "test_cancel: all checks passed" << std::endl;
  return 0;
}
