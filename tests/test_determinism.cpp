// Thread completion order must not change the reduction result: the
// parallel fixed-block-tree reduction is compared against the serial
// tree model across block sizes, thread counts and random inputs.
#include <chrono>
#include <iostream>
#include <optional>
#include <thread>
#include <vector>

#include "check.hpp"
#include "xreduce/bigint.hpp"
#include "xreduce/rational.hpp"
#include "xreduce/reduce.hpp"

using xreduce::BigInt;
using xreduce::BufferTracker;
using xreduce::CancelToken;
using xreduce::Rational;
using xreduce::ReduceOptions;
using xrtest::Rng;

int main() {
  const std::size_t n = 100000;

  // Exact integer data: pseudo-random signed 63-bit values; the true sum
  // exceeds 64 bits, so exactness really is exercised.
  std::vector<BigInt> ints(n);
  {
    Rng rng(2026);
    for (auto &v : ints) {
      long long x = static_cast<long long>(rng.next() >> 1);
      v = BigInt((rng.next() & 1) ? x : -x);
    }
  }
  auto int_map = [&](std::size_t i) -> std::optional<BigInt> {
    return ints[i];
  };
  auto int_add = [](const BigInt &a, const BigInt &b) { return a + b; };

  // Exact rational data: v_i = num_i / den_i with big mixed-sign values.
  std::vector<Rational> rats(n);
  {
    Rng rng(777);
    for (auto &v : rats) {
      long long num = static_cast<long long>(rng.next() % 1000000);
      long long den = static_cast<long long>(rng.next() % 64) + 1;
      v = Rational(BigInt(num), BigInt(den));
    }
  }
  auto rat_map = [&](std::size_t i) -> std::optional<Rational> {
    return rats[i];
  };
  auto rat_add = [](const Rational &a, const Rational &b) { return a + b; };

  const std::size_t block_sizes[] = {1, 7, 64, 333, 100000};
  const unsigned thread_counts[] = {1, 2, 3, 4, 8, 16};

  std::size_t trials = 0;
  for (std::size_t bs : block_sizes) {
    auto int_ref =
        xreduce::serial_tree_reduce<BigInt>(n, int_map, int_add, bs);
    auto rat_ref =
        xreduce::serial_tree_reduce<Rational>(n, rat_map, rat_add, bs);
    CHECK(int_ref.has_value());
    CHECK(rat_ref.has_value());
    for (unsigned tc : thread_counts) {
      BufferTracker tracker;
      ReduceOptions opts{bs, tc};
      auto int_out =
          xreduce::parallel_reduce<BigInt>(n, int_map, int_add, opts, nullptr,
                                           &tracker);
      auto rat_out =
          xreduce::parallel_reduce<Rational>(n, rat_map, rat_add, opts,
                                             nullptr, &tracker);
      CHECK(int_out.value.has_value());
      CHECK(rat_out.value.has_value());
      CHECK(!int_out.cancelled && !rat_out.cancelled);
      CHECK(!int_out.failed_block && !rat_out.failed_block);
      CHECK(*int_out.value == *int_ref); // order-independent result
      CHECK(*rat_out.value == *rat_ref);
      CHECK(tracker.live() == 0); // all buffers released
      ++trials;
    }
  }

  // Cross-check the exact integer sum against 128-bit arithmetic.
  __int128 sum128 = 0;
  for (const auto &v : ints)
    sum128 += std::stoll(v.to_string());
  unsigned __int128 mag =
      sum128 >= 0 ? static_cast<unsigned __int128>(sum128)
                  : 0 - static_cast<unsigned __int128>(sum128);
  std::string s128;
  do {
    s128 += static_cast<char>('0' + mag % 10);
    mag /= 10;
  } while (mag != 0);
  if (sum128 < 0)
    s128 += '-';
  std::string expect(s128.rbegin(), s128.rend());
  auto int_model =
      xreduce::serial_tree_reduce<BigInt>(n, int_map, int_add, 64);
  CHECK(int_model->to_string() == expect);

  std::cout << "test_determinism: " << trials
            << " parallel/serial comparisons passed; integer sum = "
            << int_model->to_string() << std::endl;
  return 0;
}
