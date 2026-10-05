// Barrier disorder: threads arrive at phase barriers in arbitrary,
// shuffled order; the reduction result must still match the serial
// tree model exactly.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <iostream>
#include <mutex>
#include <optional>
#include <set>
#include <thread>
#include <vector>

#include "check.hpp"
#include "xreduce/barrier.hpp"
#include "xreduce/bigint.hpp"
#include "xreduce/rational.hpp"
#include "xreduce/reduce.hpp"

using xreduce::BigInt;
using xreduce::PhaseBarrier;
using xreduce::Rational;
using xreduce::ReduceOptions;
using xrtest::Rng;

// 1) Raw barrier: shuffled arrivals across many phases never deadlock,
//    never release early, and every phase records all parties. The
//    observed arrival orders must actually vary (disorder exercised).
static void test_raw_barrier() {
  const unsigned parties = 6;
  const int phases = 300;
  PhaseBarrier barrier(parties);

  std::vector<std::thread::id> arrival_order; // guarded by barrier lock
  std::set<std::vector<std::thread::id>> orders_seen;
  std::atomic<int> phases_completed{0};

  barrier.set_arrival_recorder([&](std::thread::id who, std::size_t) {
    // Runs under the barrier lock, in true arrival order.
    arrival_order.push_back(who);
  });
  barrier.set_completion([&] {
    CHECK(arrival_order.size() == parties); // full house before release
    orders_seen.insert(arrival_order);
    arrival_order.clear();
    phases_completed.fetch_add(1);
  });

  std::vector<std::thread> pool;
  for (unsigned t = 0; t < parties; ++t) {
    pool.emplace_back([&, t] {
      Rng rng(1000 + t);
      for (int p = 0; p < phases; ++p) {
        // Randomize arrival order with per-thread, per-phase jitter.
        std::this_thread::sleep_for(
            std::chrono::microseconds(rng.below(150)));
        barrier.arrive_and_wait();
      }
    });
  }
  for (auto &th : pool)
    th.join();
  CHECK(phases_completed.load() == phases);
  CHECK(orders_seen.size() > 1); // disorder genuinely occurred
  std::cout << "  raw barrier: " << phases << " phases, "
            << orders_seen.size() << " distinct arrival orders"
            << std::endl;
}

// 2) Reduction under scrambled completion order equals the serial model.
static void test_reduction_disorder() {
  const std::size_t n = 20000;
  const std::size_t block = 13; // deliberately odd: ragged last block

  std::vector<Rational> data(n);
  {
    Rng rng(4242);
    for (auto &v : data) {
      long long num = static_cast<long long>(rng.next() % 10000) - 5000;
      long long den = static_cast<long long>(rng.next() % 50) + 1;
      v = Rational(BigInt(num), BigInt(den));
    }
  }
  auto add = [](const Rational &a, const Rational &b) { return a + b; };
  auto plain_map = [&](std::size_t i) -> std::optional<Rational> {
    return data[i];
  };

  auto ref = xreduce::serial_tree_reduce<Rational>(n, plain_map, add, block);
  CHECK(ref.has_value());

  std::set<std::string> orders_seen;
  for (int trial = 0; trial < 30; ++trial) {
    // Scramble block completion order with data-dependent jitter.
    Rng rng(static_cast<std::uint64_t>(trial) * 7919 + 1);
    std::uint64_t seed = rng.next();
    auto slow_map = [&](std::size_t i) -> std::optional<Rational> {
      std::uint64_t h = (i * 0x9E3779B97F4A7C15ULL) ^ seed;
      h ^= h >> 33;
      std::this_thread::sleep_for(std::chrono::microseconds(h % 120));
      return data[i];
    };
    auto out = xreduce::parallel_reduce<Rational>(n, slow_map, add,
                                                  ReduceOptions{block, 8});
    CHECK(out.value.has_value());
    CHECK(*out.value == *ref); // identical to the serial tree model
  }
}

int main() {
  test_raw_barrier();
  test_reduction_disorder();
  std::cout << "test_barrier: all checks passed" << std::endl;
  return 0;
}
