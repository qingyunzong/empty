// Verifies Merger output against a full-array reference merge model:
// concatenate every (record, source) pair, then stable-sort by
// (key, source index). Randomized cases include injected pauses.

#include <algorithm>
#include <cstdio>
#include <memory>
#include <random>
#include <tuple>
#include <vector>

#include "controlled_source.hpp"

namespace {

struct Entry {
  std::int64_t key;
  std::int64_t value;
  std::size_t source;
  std::size_t seq;
};

std::vector<Entry> ModelMerge(
    const std::vector<std::vector<kmerge::Record>>& inputs) {
  std::vector<Entry> all;
  for (std::size_t src = 0; src < inputs.size(); ++src) {
    for (std::size_t seq = 0; seq < inputs[src].size(); ++seq) {
      all.push_back({inputs[src][seq].key, inputs[src][seq].value, src, seq});
    }
  }
  std::stable_sort(all.begin(), all.end(), [](const Entry& a, const Entry& b) {
    return std::tie(a.key, a.source, a.seq) <
           std::tie(b.key, b.source, b.seq);
  });
  return all;
}

void CheckAgainstModel(const std::vector<std::vector<kmerge::Record>>& inputs,
                       bool inject_pauses, std::mt19937_64& rng) {
  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  std::vector<std::shared_ptr<SourceStats>> stats;
  for (const auto& records : inputs) {
    std::vector<ControlledSource::Step> steps;
    for (kmerge::Record rec : records) {
      if (inject_pauses && (rng() % 4 == 0)) {
        steps.push_back(ControlledSource::Pause());
      }
      steps.push_back(ControlledSource::Emit(rec));
    }
    if (inject_pauses && (rng() % 4 == 0)) {
      steps.push_back(ControlledSource::Pause());
    }
    auto source = std::make_unique<ControlledSource>(std::move(steps));
    stats.push_back(source->stats());
    cursors.push_back(std::move(source));
  }

  std::vector<kmerge::NextResult> got;
  {
    kmerge::Merger merger(std::move(cursors));
    got = Drain(merger);
  }

  std::vector<Entry> expected = ModelMerge(inputs);
  CHECK(got.size() == expected.size());
  for (std::size_t i = 0; i < got.size(); ++i) {
    CHECK(got[i].record.key == expected[i].key);
    CHECK(got[i].record.value == expected[i].value);
    CHECK(got[i].source == expected[i].source);
  }
  for (const auto& stat : stats) {
    CHECK(stat->close_count == 1);
  }
}

void DeterministicCases() {
  std::mt19937_64 rng(12345);

  // K = 0.
  CheckAgainstModel({}, false, rng);

  // Single source.
  CheckAgainstModel({{{1, 10}, {2, 20}, {2, 21}, {5, 50}}}, false, rng);

  // Empty sources mixed with non-empty ones.
  CheckAgainstModel({{}, {{1, 1}}, {}, {{1, 2}, {3, 3}}, {}}, false, rng);

  // Duplicate keys across sources: ties resolve by source index.
  CheckAgainstModel({{{1, 100}, {3, 300}, {5, 500}},
                     {{1, 101}, {2, 200}, {5, 501}},
                     {{1, 102}, {5, 502}, {5, 503}}},
                    false, rng);

  // Duplicate keys within one source keep arrival order.
  CheckAgainstModel({{{7, 1}, {7, 2}, {7, 3}}, {{7, 4}}}, false, rng);
}

void RandomizedCases() {
  std::mt19937_64 rng(20261007);
  for (int trial = 0; trial < 300; ++trial) {
    const std::size_t k = 1 + rng() % 8;
    std::vector<std::vector<kmerge::Record>> inputs(k);
    for (std::size_t src = 0; src < k; ++src) {
      const std::size_t len = rng() % 50;
      std::vector<std::int64_t> keys(len);
      for (auto& key : keys) {
        key = static_cast<std::int64_t>(rng() % 20);
      }
      std::sort(keys.begin(), keys.end());
      for (std::size_t i = 0; i < len; ++i) {
        inputs[src].push_back({keys[i], static_cast<std::int64_t>(i)});
      }
    }
    CheckAgainstModel(inputs, /*inject_pauses=*/(trial % 2 == 1), rng);
  }
}

}  // namespace

int main() {
  DeterministicCases();
  RandomizedCases();
  std::puts("model_test: OK");
  return 0;
}
