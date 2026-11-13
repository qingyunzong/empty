#include "dataeng.hpp"

#include <atomic>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

int failures = 0;

void report(bool condition, const char* expression, const char* file, int line) {
  if (!condition) {
    std::cerr << file << ':' << line << ": check failed: " << expression
              << '\n';
    ++failures;
  }
}

#define CHECK(expression) \
  report(static_cast<bool>(expression), #expression, __FILE__, __LINE__)

template <class Function>
bool throws_transaction_error(Function&& function) {
  try {
    std::forward<Function>(function)();
  } catch (const dataeng::transaction_error&) {
    return true;
  } catch (...) {
    return false;
  }
  return false;
}

using IntAgg = dataeng::IncrementalAggregator<std::string, std::int64_t>;

void test_basic_aggregation() {
  IntAgg agg;
  agg.apply({{"a", 5, 1}, {"a", 3, 2}, {"a", 9, 1}, {"b", 100, 1}});

  const auto view = agg.snapshot();
  CHECK(view->size() == 2);

  const auto a = view->find("a");
  CHECK(a.has_value());
  CHECK(a->sum == 20);
  CHECK(a->count == 4);
  CHECK(a->min == 3);
  CHECK(a->max == 9);
  CHECK(view->distinct_value_count("a") == 3);

  const auto b = view->find("b");
  CHECK(b.has_value());
  CHECK(b->sum == 100);
  CHECK(b->count == 1);
  CHECK(b->min == 100);
  CHECK(b->max == 100);

  CHECK(!view->contains("missing"));
  CHECK(!view->find("missing").has_value());
}

void test_extreme_replacement() {
  IntAgg agg;
  agg.apply({{"g", 10, 2}, {"g", 20, 1}, {"g", 30, 3}});
  CHECK(agg.find("g")->sum == 130);
  CHECK(agg.find("g")->count == 6);
  CHECK(agg.find("g")->min == 10);
  CHECK(agg.find("g")->max == 30);

  agg.retract("g", 10, 1);
  auto g = agg.find("g");
  CHECK(g->count == 5);
  CHECK(g->sum == 120);
  CHECK(g->min == 10);
  CHECK(g->max == 30);

  agg.retract("g", 10, 1);
  g = agg.find("g");
  CHECK(g->count == 4);
  CHECK(g->sum == 110);
  CHECK(g->min == 20);
  CHECK(g->max == 30);

  agg.retract("g", 30, 2);
  g = agg.find("g");
  CHECK(g->count == 2);
  CHECK(g->sum == 50);
  CHECK(g->min == 20);
  CHECK(g->max == 30);

  agg.retract("g", 30, 1);
  g = agg.find("g");
  CHECK(g->count == 1);
  CHECK(g->sum == 20);
  CHECK(g->min == 20);
  CHECK(g->max == 20);

  agg.retract("g", 20, 1);
  CHECK(!agg.contains("g"));
  CHECK(agg.empty());
}

void test_group_lifecycle() {
  IntAgg agg;
  agg.apply({{"x", 1, 1}, {"x", 2, 1}});
  agg.retract("x", 1, 1);
  agg.retract("x", 2, 1);
  CHECK(agg.empty());

  agg.insert("x", 99, 3);
  const auto x = agg.find("x");
  CHECK(x->count == 3);
  CHECK(x->sum == 297);
  CHECK(x->min == 99);
  CHECK(x->max == 99);
}

void test_transaction_atomicity() {
  IntAgg agg;
  agg.apply({{"a", 1, 1}, {"a", 2, 1}});
  const auto before_revision = agg.revision();
  const auto before = agg.find("a");

  CHECK(throws_transaction_error([&] {
    agg.apply({{"a", 5, 1}, {"a", 1, -5}});
  }));
  CHECK(agg.revision() == before_revision);
  CHECK(agg.find("a") == before);
  CHECK(agg.size() == 1);

  CHECK(throws_transaction_error([&] {
    agg.apply({{"new", 1, -1}});
  }));
  CHECK(!agg.contains("new"));
  CHECK(agg.revision() == before_revision);

  const auto snapshot_before = agg.snapshot();
  CHECK(throws_transaction_error([&] {
    agg.apply({{"a", 2, -1}, {"b", 7, 1}, {"b", 7, -2}});
  }));
  const auto snapshot_after = agg.snapshot();
  CHECK(snapshot_before->find("a") == snapshot_after->find("a"));
  CHECK(!snapshot_after->contains("b"));
  CHECK(snapshot_after->size() == snapshot_before->size());
}

void test_net_multiplicity_and_order() {
  IntAgg agg;
  agg.apply({{"g", 10, 3}});
  const auto revision = agg.revision();
  agg.apply({{"g", 10, -1}, {"g", 10, 1}});
  CHECK(agg.revision() == revision);
  CHECK(agg.find("g")->count == 3);
  CHECK(agg.find("g")->sum == 30);

  const std::vector<IntAgg::Row> forward{
      {"g", 10, -1}, {"g", 20, 2}, {"g", 10, 1}, {"g", 30, -1}};
  const std::vector<IntAgg::Row> reverse(forward.rbegin(), forward.rend());

  IntAgg lhs;
  IntAgg rhs;
  lhs.apply({{"g", 10, 2}, {"g", 20, 1}, {"g", 30, 1}});
  rhs.apply({{"g", 30, 1}, {"g", 20, 1}, {"g", 10, 2}});
  lhs.apply(forward);
  rhs.apply(reverse);

  const auto left = lhs.find("g");
  const auto right = rhs.find("g");
  CHECK(left.has_value());
  CHECK(right.has_value());
  CHECK(left->count == 5);
  CHECK(left->sum == 80);
  CHECK(left->min == 10);
  CHECK(left->max == 20);
  CHECK(left == right);
}

void test_snapshot_isolation() {
  IntAgg agg;
  agg.apply({{"g", 1, 1}});
  const auto old = agg.snapshot();

  agg.apply({{"g", 2, 1}, {"h", 9, 1}});
  const auto fresh = agg.snapshot();

  CHECK(old->size() == 1);
  CHECK(old->find("g")->count == 1);
  CHECK(old->find("g")->max == 1);
  CHECK(!old->contains("h"));

  CHECK(fresh->size() == 2);
  CHECK(fresh->find("g")->count == 2);
  CHECK(fresh->find("g")->max == 2);
  CHECK(fresh->find("h")->sum == 9);

  agg.retract("g", 1, 1);
  agg.retract("g", 2, 1);
  agg.retract("h", 9, 1);
  CHECK(old->find("g")->count == 1);
  CHECK(fresh->find("g")->count == 2);
  CHECK(agg.empty());
}

void test_transaction_builder() {
  IntAgg agg;
  IntAgg::Transaction transaction;
  transaction.insert("g", 5, 2)
      .insert("g", 8, 1)
      .retract("g", 5, 1)
      .add({"g", 9, 1});
  CHECK(transaction.size() == 4);

  agg.apply(transaction);
  const auto g = agg.find("g");
  CHECK(g->count == 3);
  CHECK(g->sum == 22);
  CHECK(g->min == 5);
  CHECK(g->max == 9);

  CHECK(throws_transaction_error([] {
    IntAgg::Transaction bad;
    bad.insert("x", 1, 0);
  }));
  CHECK(throws_transaction_error([] {
    IntAgg::Transaction bad;
    bad.retract("x", 1, -1);
  }));
}

void test_bounded_ordered_state() {
  IntAgg agg;
  std::vector<IntAgg::Row> rows;
  rows.reserve(10000);
  for (int i = 0; i < 10000; ++i) {
    rows.push_back({"g", 42, 1});
  }

  agg.apply(rows);
  auto view = agg.snapshot();
  auto g = view->find("g");
  CHECK(g->count == 10000);
  CHECK(g->sum == 420000);
  CHECK(g->min == 42);
  CHECK(g->max == 42);
  CHECK(view->distinct_value_count("g") == 1);

  agg.retract("g", 42, 9999);
  g = agg.find("g");
  CHECK(g->count == 1);
  CHECK(g->sum == 42);

  agg.retract("g", 42, 1);
  CHECK(agg.empty());
}

void test_floating_point_value() {
  using DoubleAgg = dataeng::IncrementalAggregator<std::string, double>;
  DoubleAgg agg;
  agg.apply({{"g", 0.5, 2}, {"g", 1.25, 1}});

  auto g = agg.find("g");
  CHECK(std::abs(g->sum - 2.25) < 1e-12);
  CHECK(g->count == 3);
  CHECK(g->min == 0.5);
  CHECK(g->max == 1.25);

  agg.retract("g", 0.5, 2);
  g = agg.find("g");
  CHECK(g->count == 1);
  CHECK(g->min == 1.25);
  CHECK(g->max == 1.25);
}

void test_iteration() {
  IntAgg agg;
  agg.apply({{"a", 1, 1}, {"b", 2, 1}, {"b", 3, 1}});
  const auto view = agg.snapshot();

  std::size_t group_count = 0;
  std::int64_t sum = 0;
  for (const auto& entry : *view) {
    ++group_count;
    sum += entry.aggregate.sum;
    CHECK(entry.aggregate.count > 0);
    CHECK(entry.aggregate.min <= entry.aggregate.max);
    CHECK(view->contains(entry.key));
  }

  CHECK(group_count == 2);
  CHECK(sum == 6);
}

void test_empty_and_zero_multiplicity() {
  IntAgg agg;
  const std::vector<IntAgg::Row> empty;
  agg.apply(empty);
  agg.apply({{"g", 1, 0}});
  CHECK(agg.empty());
  CHECK(agg.revision() == 0);
  CHECK(agg.find("g") == std::nullopt);

  const IntAgg::Row single{"g", 5, 2};
  agg.apply(single);
  CHECK(agg.find("g")->count == 2);
  CHECK(agg.find("g")->sum == 10);
  CHECK(agg.find("g")->min == 5);
}

void test_multiplicity_overflow() {
  IntAgg agg;
  constexpr auto maximum = std::numeric_limits<dataeng::multiplicity_t>::max();
  agg.insert("g", 1, maximum);
  CHECK(agg.find("g")->count == maximum);

  const auto revision = agg.revision();
  CHECK(throws_transaction_error([&] { agg.insert("g", 1, 1); }));
  CHECK(agg.revision() == revision);
  CHECK(agg.find("g")->count == maximum);
}

void test_concurrent_snapshot_visibility() {
  IntAgg agg;
  agg.apply({{"g", 0, 1}});

  std::atomic<bool> stop{false};
  std::atomic<bool> failed{false};
  std::thread reader([&] {
    while (!stop.load(std::memory_order_acquire)) {
      const auto view = agg.snapshot();
      const auto g = view->find("g");
      if (!g.has_value() || g->count != 1 || g->min != g->max ||
          view->size() != 1) {
        failed.store(true, std::memory_order_release);
        return;
      }
    }
  });

  constexpr int iterations = 20000;
  for (int i = 0; i < iterations; ++i) {
    agg.apply({{"g", i, -1}, {"g", i + 1, 1}});
  }

  stop.store(true, std::memory_order_release);
  reader.join();

  CHECK(!failed.load(std::memory_order_acquire));
  const auto g = agg.find("g");
  CHECK(g->count == 1);
  CHECK(g->min == iterations);
  CHECK(g->max == iterations);
  CHECK(g->sum == iterations);
  CHECK(agg.revision() == static_cast<std::uint64_t>(iterations) + 1);
}

}  // namespace

int main() {
  test_basic_aggregation();
  test_extreme_replacement();
  test_group_lifecycle();
  test_transaction_atomicity();
  test_net_multiplicity_and_order();
  test_snapshot_isolation();
  test_transaction_builder();
  test_bounded_ordered_state();
  test_floating_point_value();
  test_iteration();
  test_empty_and_zero_multiplicity();
  test_multiplicity_overflow();
  test_concurrent_snapshot_visibility();

  if (failures != 0) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "all dataeng tests passed\n";
  return 0;
}
