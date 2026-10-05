// Block failure: when several blocks fail, the reduction reports the
// smallest failing block index and returns no value.
#include <iostream>
#include <optional>

#include "check.hpp"
#include "xreduce/bigint.hpp"
#include "xreduce/reduce.hpp"

using xreduce::BigInt;
using xreduce::ReduceOptions;

int main() {
  const std::size_t n = 2000;
  const std::size_t block = 10; // 200 blocks

  // Blocks 2 and 5 fail (elements [20,30) and [50,60)). With 8 threads
  // both are reached in the first scheduling wave, so both failures are
  // observed and the minimum must win regardless of detection order.
  auto fails = [](std::size_t i) {
    return (i >= 20 && i < 30) || (i >= 50 && i < 60);
  };
  auto map = [&](std::size_t i) -> std::optional<BigInt> {
    if (fails(i))
      return std::nullopt;
    return BigInt(static_cast<long long>(i));
  };
  auto add = [](const BigInt &a, const BigInt &b) { return a + b; };

  for (int trial = 0; trial < 50; ++trial) {
    auto out = xreduce::parallel_reduce<BigInt>(n, map, add,
                                                ReduceOptions{block, 8});
    CHECK(!out.value.has_value());
    CHECK(!out.cancelled);
    CHECK(out.failed_block.has_value());
    CHECK(*out.failed_block == 2); // smallest failing block index
  }

  // Serial model agrees there is no result.
  auto ref = xreduce::serial_tree_reduce<BigInt>(n, map, add, block);
  CHECK(!ref.has_value());

  // A single failure in the last block is reported exactly.
  auto map_last = [&](std::size_t i) -> std::optional<BigInt> {
    if (i == n - 1)
      return std::nullopt;
    return BigInt(static_cast<long long>(i));
  };
  auto out_last = xreduce::parallel_reduce<BigInt>(n, map_last, add,
                                                   ReduceOptions{block, 4});
  CHECK(out_last.failed_block.has_value());
  CHECK(*out_last.failed_block == (n - 1) / block);

  std::cout << "test_failure: all checks passed" << std::endl;
  return 0;
}
