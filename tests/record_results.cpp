// Runs the library's key scenarios and records the ACTUAL computed
// results into a text file (path given as argv[1]).
#include <atomic>
#include <chrono>
#include <fstream>
#include <future>
#include <iostream>
#include <optional>
#include <thread>

#include "check.hpp"
#include "xreduce/bigint.hpp"
#include "xreduce/rational.hpp"
#include "xreduce/reduce.hpp"

using xreduce::BigInt;
using xreduce::BufferTracker;
using xreduce::CancelToken;
using xreduce::Rational;
using xreduce::ReduceOptions;

int main(int argc, char **argv) {
  const char *path = argc > 1 ? argv[1] : "actual_results.txt";
  std::ofstream out(path);
  CHECK(out.good());

  auto add_i = [](const BigInt &a, const BigInt &b) { return a + b; };
  auto add_r = [](const Rational &a, const Rational &b) { return a + b; };

  // 1) Exact harmonic number H_100, parallel vs serial tree model.
  auto harmonic_map = [](std::size_t i) -> std::optional<Rational> {
    return Rational(BigInt(1), BigInt(static_cast<long long>(i + 1)));
  };
  auto h_par = xreduce::parallel_reduce<Rational>(
      100, harmonic_map, add_r, ReduceOptions{7, 8});
  auto h_ser =
      xreduce::serial_tree_reduce<Rational>(100, harmonic_map, add_r, 7);
  CHECK(h_par.value.has_value() && h_ser.has_value());
  CHECK(*h_par.value == *h_ser);
  out << "H_100 (parallel, 8 threads, block=7) = " << h_par.value->to_string()
      << "\n";
  out << "H_100 (serial tree model, block=7)  = " << h_ser->to_string()
      << "\n";
  out << "H_100 parallel == serial: " << (*h_par.value == *h_ser ? "yes" : "no")
      << "\n";

  // 2) Sum of 2^i for i in [0,200) = 2^200 - 1, exact big integer.
  auto pow2_map = [](std::size_t i) -> std::optional<BigInt> {
    return BigInt::pow2(i);
  };
  auto p_par =
      xreduce::parallel_reduce<BigInt>(200, pow2_map, add_i,
                                       ReduceOptions{3, 4});
  auto p_ser = xreduce::serial_tree_reduce<BigInt>(200, pow2_map, add_i, 3);
  CHECK(p_par.value.has_value() && *p_par.value == *p_ser);
  CHECK(p_par.value->to_string() ==
        "1606938044258990275541962092341162602522202993782792835301375");
  out << "sum_{i=0..199} 2^i = " << p_par.value->to_string() << "\n";

  // 3) Sum 1..100000 cross-checked against n(n+1)/2.
  auto nat_map = [](std::size_t i) -> std::optional<BigInt> {
    return BigInt(static_cast<long long>(i + 1));
  };
  auto s_par = xreduce::parallel_reduce<BigInt>(100000, nat_map, add_i,
                                                ReduceOptions{64, 8});
  CHECK(s_par.value.has_value());
  CHECK(s_par.value->to_string() == "5000050000");
  out << "sum_{i=1..100000} i = " << s_par.value->to_string() << "\n";

  // 4) Determinism under scrambled completion order: 50 trials.
  {
    int mismatches = 0;
    for (int trial = 0; trial < 50; ++trial) {
      std::uint64_t seed = static_cast<std::uint64_t>(trial) * 2654435761u;
      auto jitter_map = [&](std::size_t i) -> std::optional<Rational> {
        std::uint64_t h = (i * 0x9E3779B97F4A7C15ULL) ^ seed;
        h ^= h >> 33;
        std::this_thread::sleep_for(std::chrono::microseconds(h % 200));
        return Rational(BigInt(static_cast<long long>((i * 37) % 101)),
                        BigInt(static_cast<long long>((i % 89) + 1)));
      };
      auto par = xreduce::parallel_reduce<Rational>(5000, jitter_map, add_r,
                                                    ReduceOptions{13, 8});
      auto ser = xreduce::serial_tree_reduce<Rational>(5000, jitter_map,
                                                       add_r, 13);
      if (!(par.value.has_value() && *par.value == *ser))
        ++mismatches;
    }
    out << "determinism trials (randomized arrival order): 50, mismatches: "
        << mismatches << "\n";
    CHECK(mismatches == 0);
  }

  // 5) Failure: blocks 2 and 5 fail -> smallest failing block reported.
  {
    auto fail_map = [](std::size_t i) -> std::optional<BigInt> {
      std::size_t b = i / 10;
      if (b == 2 || b == 5)
        return std::nullopt;
      return BigInt(static_cast<long long>(i));
    };
    auto res = xreduce::parallel_reduce<BigInt>(200, fail_map, add_i,
                                                ReduceOptions{10, 8});
    CHECK(!res.value.has_value());
    CHECK(res.failed_block.has_value() && *res.failed_block == 2);
    out << "failing blocks {2,5} -> reported smallest block: "
        << *res.failed_block << "\n";
  }

  // 6) Cancellation: no value, all buffers released.
  {
    CancelToken token;
    BufferTracker tracker;
    std::atomic<bool> release{false};
    std::atomic<std::size_t> started{0};
    auto slow_map = [&](std::size_t i) -> std::optional<BigInt> {
      started.fetch_add(1, std::memory_order_relaxed);
      while (!release.load(std::memory_order_acquire))
        std::this_thread::yield();
      return BigInt(static_cast<long long>(i));
    };
    auto fut = std::async(std::launch::async, [&] {
      return xreduce::parallel_reduce<BigInt>(100000, slow_map, add_i,
                                              ReduceOptions{64, 4}, &token,
                                              &tracker);
    });
    while (started.load(std::memory_order_relaxed) == 0)
      std::this_thread::yield();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    token.cancel();
    release.store(true, std::memory_order_release);
    auto res = fut.get();
    CHECK(!res.value.has_value());
    CHECK(res.cancelled);
    CHECK(tracker.live() == 0);
    out << "cancelled run: value=" << (res.value ? "some" : "none")
        << ", cancelled=" << (res.cancelled ? "true" : "false")
        << ", live buffers after return=" << tracker.live() << "\n";
  }

  out << "ALL RECORDED VALUES VERIFIED\n";
  out.close();
  std::cout << "results recorded to " << path << std::endl;
  return 0;
}
