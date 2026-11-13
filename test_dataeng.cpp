#include "dataeng.hpp"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <utility>
#include <vector>

namespace {

int g_failures = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__,     \
                   __LINE__, #cond);                                    \
      ++g_failures;                                                     \
    }                                                                   \
  } while (0)

void check_near(double a, double b, double eps, const char* expr, int line) {
  if (!(std::fabs(a - b) <= eps)) {
    std::fprintf(stderr, "CHECK failed at line %d: %s (|%.17g - %.17g| > %g)\n",
                 line, expr, a, b, eps);
    ++g_failures;
  }
}
#define CHECK_NEAR(a, b, eps) check_near((a), (b), (eps), #a " ~ " #b, __LINE__)

void test_basic_weight_conservation() {
  dataeng::KllSketch sk(32, 42);
  std::uint64_t expect = 0;
  for (int i = 0; i < 10000; ++i) {
    const std::uint64_t w = static_cast<std::uint64_t>(i % 5) + 1;
    CHECK(sk.update(static_cast<double>(i % 1000), w));
    expect += w;
  }
  CHECK(sk.total_weight() == expect);
  CHECK(sk.validate_weight_conservation());
  CHECK(sk.num_levels() > 1);
  CHECK(sk.rank_error_bound() > 0.0);
  CHECK(sk.rank_error_bound() < 1.0);
}

void test_nan_and_weight_policy() {
  dataeng::KllSketch sk(16, 0, dataeng::NanPolicy::kReject);
  CHECK(!sk.update(std::numeric_limits<double>::quiet_NaN()));
  CHECK(sk.empty());
  CHECK(sk.update(1.0));
  bool threw = false;
  try {
    sk.update(2.0, 0);
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  CHECK(threw);
  CHECK(sk.total_weight() == 1);
}

void test_signed_zero_ordering() {
  dataeng::KllSketch sk(16, 7);
  sk.update(0.0);   // +0.0
  sk.update(-0.0);  // -0.0
  sk.update(1.0);
  CHECK(sk.min() == 0.0 && std::signbit(sk.min()));
  CHECK(sk.max() == 1.0 && !std::signbit(sk.max()));
  const double q0 = sk.quantile(0.0);
  CHECK(q0 == 0.0 && std::signbit(q0));
  CHECK_NEAR(sk.rank(0.0), 1.0 / 3.0, 1e-12);  // only -0.0 sorts before +0.0
  CHECK_NEAR(sk.rank(1.0), 2.0 / 3.0, 1e-12);
  // Ordering survives a serialization round trip.
  auto rt = dataeng::KllSketch::deserialize(sk.serialize());
  CHECK(std::signbit(rt.min()));
  CHECK_NEAR(rt.rank(0.0), 1.0 / 3.0, 1e-12);
}

void test_seed_determinism() {
  auto build = [](std::uint64_t seed) {
    dataeng::KllSketch sk(16, seed);
    for (int i = 0; i < 5000; ++i)
      sk.update(static_cast<double>((i * 7919) % 1000) / 10.0,
                static_cast<std::uint64_t>(i % 4) + 1);
    return sk;
  };
  CHECK(build(1).serialize() == build(1).serialize());
  CHECK(build(1).serialize() != build(2).serialize());
}

void test_merge_order_rank_bound() {
  constexpr int kShards = 8;
  constexpr int kPerShard = 4000;
  std::vector<std::pair<double, std::uint64_t>> samples;
  std::uint64_t total = 0;
  for (int i = 0; i < kShards * kPerShard; ++i) {
    const double v = static_cast<double>(
                         (static_cast<std::uint64_t>(i) * 2862933555777941757ULL) %
                         100000ULL) /
                     100.0;
    const std::uint64_t w = static_cast<std::uint64_t>(i % 3) + 1;
    samples.push_back({v, w});
    total += w;
  }
  std::vector<dataeng::KllSketch> shards;
  for (int s = 0; s < kShards; ++s) {
    dataeng::KllSketch sk(64, static_cast<std::uint64_t>(1000 + s));
    for (int i = s; i < static_cast<int>(samples.size()); i += kShards)
      sk.update(samples[static_cast<std::size_t>(i)].first,
                samples[static_cast<std::size_t>(i)].second);
    shards.push_back(std::move(sk));
  }
  auto true_rank = [&](double x) {
    std::uint64_t c = 0;
    for (const auto& [v, w] : samples)
      if (v < x) c += w;
    return static_cast<double>(c) / static_cast<double>(total);
  };
  const std::vector<std::vector<int>> orders = {
      {0, 1, 2, 3, 4, 5, 6, 7},
      {7, 6, 5, 4, 3, 2, 1, 0},
      {3, 0, 6, 1, 7, 2, 5, 4},
  };
  for (const auto& order : orders) {
    std::vector<dataeng::KllSketch> level;
    for (int idx : order) level.push_back(shards[static_cast<std::size_t>(idx)]);
    while (level.size() > 1) {  // pairwise tree merge in the given order
      std::vector<dataeng::KllSketch> next;
      for (std::size_t i = 0; i < level.size(); i += 2) {
        if (i + 1 == level.size()) {
          next.push_back(std::move(level[i]));
          break;
        }
        level[i].merge(level[i + 1]);
        next.push_back(std::move(level[i]));
      }
      level = std::move(next);
    }
    const dataeng::KllSketch& merged = level.front();
    CHECK(merged.total_weight() == total);
    CHECK(merged.validate_weight_conservation());
    const double bound = merged.rank_error_bound();
    CHECK(bound > 0.0 && bound < 1.0);
    for (double x : {50.0, 250.5, 500.0, 750.5, 999.0}) {
      CHECK(std::fabs(merged.rank(x) - true_rank(x)) <= bound + 1e-9);
    }
  }
}

void test_serialization_round_trip() {
  dataeng::KllSketch sk(32, 99);
  std::uint64_t total = 0;
  for (int i = 0; i < 20000; ++i) {
    const std::uint64_t w = static_cast<std::uint64_t>(i % 7) + 1;
    sk.update(std::sin(static_cast<double>(i)) * 500.0, w);
    total += w;
  }
  const auto bytes = sk.serialize();
  auto restored = dataeng::KllSketch::deserialize(bytes);
  CHECK(restored.serialize() == bytes);
  CHECK(restored.total_weight() == total);
  CHECK(restored.validate_weight_conservation());
  CHECK(restored.k() == sk.k());
  CHECK(restored.seed() == sk.seed());

  bool threw = false;
  auto corrupt = bytes;
  corrupt.back() ^= 0xff;  // flips a weight byte: breaks weight conservation
  try {
    dataeng::KllSketch::deserialize(corrupt);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);

  threw = false;
  try {
    dataeng::KllSketch::deserialize(
        std::vector<std::uint8_t>(bytes.begin(), bytes.end() - 3));
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);

  threw = false;
  auto bad_magic = bytes;
  bad_magic[0] = 'X';
  try {
    dataeng::KllSketch::deserialize(bad_magic);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
}

void test_quantile_accuracy() {
  dataeng::KllSketch sk(200, 7);
  constexpr int n = 100000;
  for (int i = 0; i < n; ++i) sk.update(static_cast<double>(i));
  CHECK(sk.total_weight() == static_cast<std::uint64_t>(n));
  const double bound = sk.rank_error_bound();
  CHECK(bound > 0.0 && bound < 0.2);
  for (double r : {0.1, 0.25, 0.5, 0.75, 0.9}) {
    const double q = sk.quantile(r);
    CHECK_NEAR(sk.rank(q), r, bound + 0.01);
    CHECK(std::fabs(q - r * n) <= (bound + 0.01) * n);
  }
  CHECK(sk.quantile(0.0) == sk.min());
  CHECK(sk.quantile(1.0) == sk.max());
}

void test_empty_and_invalid() {
  dataeng::KllSketch sk;
  CHECK(sk.empty());
  CHECK(sk.rank(1.0) == 0.0);
  CHECK(sk.rank_error_bound() == 0.0);
  bool threw = false;
  try {
    sk.quantile(0.5);
  } catch (const std::logic_error&) {
    threw = true;
  }
  CHECK(threw);
  threw = false;
  try {
    sk.min();
  } catch (const std::logic_error&) {
    threw = true;
  }
  CHECK(threw);
  threw = false;
  try {
    dataeng::KllSketch bad(2);  // below kMinK
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  CHECK(threw);
  auto rt = dataeng::KllSketch::deserialize(sk.serialize());
  CHECK(rt.empty());
}

}  // namespace

int main() {
  test_basic_weight_conservation();
  test_nan_and_weight_policy();
  test_signed_zero_ordering();
  test_seed_determinism();
  test_merge_order_rank_bound();
  test_serialization_round_trip();
  test_quantile_accuracy();
  test_empty_and_invalid();
  if (g_failures == 0) {
    std::printf("all tests passed\n");
    return 0;
  }
  std::fprintf(stderr, "%d check(s) failed\n", g_failures);
  return 1;
}
