#include "dataeng.hpp"

#include <cstdlib>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <vector>

namespace {

using dataeng::Change;
using dataeng::ChangeKind;
using dataeng::Event;
using dataeng::EventType;
using dataeng::Record;
using dataeng::TopKOperator;

int failures = 0;

std::string toString(const Change& change) {
  std::ostringstream out;
  out << (change.kind == ChangeKind::Retract ? "-" : "+") << "("
      << change.record.group << "," << change.record.key << ","
      << change.record.score << ")";
  return out.str();
}

std::string toString(const std::vector<Change>& changes) {
  std::string out;
  for (const Change& change : changes) {
    if (!out.empty()) out += " ";
    out += toString(change);
  }
  return out;
}

void expectEq(const std::vector<Change>& actual,
              const std::vector<Change>& expected, const std::string& label) {
  if (actual != expected) {
    ++failures;
    std::cerr << "FAIL " << label << "\n  expected: " << toString(expected)
              << "\n  actual:   " << toString(actual) << "\n";
  }
}

void expectTrue(bool condition, const std::string& label) {
  if (!condition) {
    ++failures;
    std::cerr << "FAIL " << label << "\n";
  }
}

Change ins(const Record& r) { return {ChangeKind::Insert, r}; }
Change ret(const Record& r) { return {ChangeKind::Retract, r}; }

void testBasicInsertAndEviction() {
  TopKOperator op(2);
  expectEq(op.insert({"g", "a", 10}), {ins({"g", "a", 10})}, "insert a");
  expectEq(op.insert({"g", "b", 20}), {ins({"g", "b", 20})}, "insert b");
  // Below the cut: no output.
  expectEq(op.insert({"g", "c", 5}), {}, "insert c below cut");
  // Evicts the lowest member a.
  expectEq(op.insert({"g", "d", 30}),
           {ret({"g", "a", 10}), ins({"g", "d", 30})}, "insert d evicts a");
  expectTrue(op.topK("g") == (std::vector<Record>{{"g", "d", 30},
                                                  {"g", "b", 20}}),
             "topK after eviction");
}

void testStableTieBreak() {
  TopKOperator op(2);
  op.insert({"g", "b", 10});
  op.insert({"g", "a", 10});
  // Equal scores: key ascending wins, so c never enters.
  expectEq(op.insert({"g", "c", 10}), {}, "tie loser enters nothing");
  expectTrue(op.topK("g") == (std::vector<Record>{{"g", "a", 10},
                                                  {"g", "b", 10}}),
             "tie order by key");
  // Deleting a promotes c (stable next-in-line).
  expectEq(op.erase({"g", "a", 10}),
           {ret({"g", "a", 10}), ins({"g", "c", 10})}, "delete promotes tie");
}

void testUpdateSameGroup() {
  TopKOperator op(2);
  op.insert({"g", "a", 10});
  op.insert({"g", "b", 20});
  op.insert({"g", "c", 30});
  // Score change of a top-K member: row itself changed -> retract + insert.
  expectEq(op.updateBefore({"g", "b", 20}), {}, "update_before silent");
  expectEq(op.updateAfter({"g", "b", 25}),
           {ret({"g", "b", 20}), ins({"g", "b", 25})}, "score update in topK");
  // Still a member after another score change: minimal row replacement.
  expectEq(op.updateAfter({"g", "b", 29}),
           {ret({"g", "b", 25}), ins({"g", "b", 29})}, "member row replaced");
  // Non-member rises into top-K, evicting b.
  expectEq(op.updateBefore({"g", "a", 10}), {}, "update_before a");
  expectEq(op.updateAfter({"g", "a", 40}),
           {ret({"g", "b", 29}), ins({"g", "a", 40})}, "a rises, b evicted");
  // No-op update.
  expectEq(op.updateAfter({"g", "a", 40}), {}, "no-op update");
}

void testCrossGroupTransaction() {
  TopKOperator op(1);
  op.insert({"src", "a", 10});
  op.insert({"src", "b", 5});
  op.insert({"dst", "c", 20});
  op.insert({"dst", "d", 15});
  // Move a (src leader) to dst where it leads: src retracts a and promotes b;
  // dst evicts c and inserts a. Source group delta comes first.
  op.updateBefore({"src", "a", 10});
  expectEq(op.updateAfter({"dst", "a", 30}),
           {ret({"src", "a", 10}), ins({"src", "b", 5}),
            ret({"dst", "c", 20}), ins({"dst", "a", 30})},
           "cross-group move");
  // Move a back to src with a low score: enters neither top-K... src top is
  // b(5), a(1) stays out; dst top is d(15) after c left? c was evicted from
  // top-K but still tracked; a leaves dst so c(20) re-enters.
  expectEq(op.updateAfter({"src", "a", 1}),
           {ret({"dst", "a", 30}), ins({"dst", "c", 20})},
           "move back as non-member");
  expectTrue(op.topK("src") == std::vector<Record>{{"src", "b", 5}},
             "src top after moves");
  expectTrue(op.topK("dst") == std::vector<Record>{{"dst", "c", 20}},
             "dst top after moves");
}

void testDelete() {
  TopKOperator op(2);
  op.insert({"g", "a", 10});
  op.insert({"g", "b", 20});
  op.insert({"g", "c", 30});
  // a is tracked but below the cut: deleting it emits nothing.
  expectEq(op.erase({"g", "a", 10}), {}, "delete below cut silent");
  op.insert({"g", "a", 10});
  // Member delete promotes a.
  expectEq(op.erase({"g", "b", 20}),
           {ret({"g", "b", 20}), ins({"g", "a", 10})}, "delete promotes");
  expectEq(op.erase({"g", "c", 30}), {ret({"g", "c", 30})}, "delete leader");
  expectEq(op.erase({"g", "a", 10}), {ret({"g", "a", 10})}, "delete last");
  expectTrue(op.size() == 0, "empty after deletes");
}

void testStrictness() {
  TopKOperator op(2);
  op.insert({"g", "a", 10});
  expectTrue([&] {
    try { op.insert({"g", "a", 99}); } catch (const std::invalid_argument&) {
      return true;
    }
    return false;
  }(), "duplicate insert throws");
  expectTrue([&] {
    try { op.erase({"g", "zz", 1}); } catch (const std::invalid_argument&) {
      return true;
    }
    return false;
  }(), "unknown delete throws");
  expectTrue([&] {
    try { op.updateBefore({"g", "a", 11}); } catch (
        const std::invalid_argument&) { return true; }
    return false;
  }(), "mismatched update_before throws");
  expectTrue([&] {
    try { op.insert({"g", "n", 0.0 / 0.0}); } catch (
        const std::invalid_argument&) { return true; }
    return false;
  }(), "NaN score throws");
  // Failed calls left state untouched.
  expectTrue(op.topK("g") == std::vector<Record>{{"g", "a", 10}},
             "state intact after rejected calls");
}

// Deterministic pseudo-random workload shared by the snapshot tests.
std::vector<Event> makeWorkload(std::mt19937& rng, std::size_t count) {
  std::vector<Event> events;
  std::vector<Record> live;  // model of tracked state
  std::uniform_int_distribution<int> group_dist(0, 2);
  std::uniform_int_distribution<int> score_dist(0, 5);
  for (std::size_t i = 0; i < count; ++i) {
    int action = static_cast<int>(rng() % 10);
    if (live.empty() || action < 4) {
      // insert a fresh key
      Record rec{"g" + std::to_string(group_dist(rng)),
                 "k" + std::to_string(rng() % 1000),
                 static_cast<double>(score_dist(rng))};
      bool exists = false;
      for (const Record& r : live) exists = exists || r.key == rec.key;
      if (exists) continue;
      live.push_back(rec);
      events.push_back({EventType::Insert, rec});
    } else if (action < 8) {
      // update an existing key (maybe across groups)
      std::size_t idx = rng() % live.size();
      Record before = live[idx];
      Record after{"g" + std::to_string(group_dist(rng)), before.key,
                   static_cast<double>(score_dist(rng))};
      events.push_back({EventType::UpdateBefore, before});
      events.push_back({EventType::UpdateAfter, after});
      live[idx] = after;
    } else {
      // delete an existing key
      std::size_t idx = rng() % live.size();
      events.push_back({EventType::Delete, live[idx]});
      live.erase(live.begin() + static_cast<long>(idx));
    }
  }
  return events;
}

std::vector<Change> runAll(TopKOperator& op, const std::vector<Event>& events,
                           std::size_t begin, std::size_t end) {
  std::vector<Change> out;
  for (std::size_t i = begin; i < end; ++i) {
    std::vector<Change> delta = op.apply(events[i]);
    out.insert(out.end(), delta.begin(), delta.end());
  }
  return out;
}

void testSnapshotRestoreEquivalence() {
  std::mt19937 rng(42);
  const std::vector<Event> events = makeWorkload(rng, 400);
  const std::size_t mid = events.size() / 2;

  TopKOperator op(3);
  runAll(op, events, 0, mid);
  const TopKOperator::Snapshot snap = op.snapshot();
  const std::vector<Change> uninterrupted = runAll(op, events, mid, events.size());

  TopKOperator restored(3);
  runAll(restored, events, 0, mid);
  restored.restore(snap);
  const std::vector<Change> after_restore =
      runAll(restored, events, mid, events.size());

  expectEq(after_restore, uninterrupted,
           "restored run matches uninterrupted output");
  for (const std::string& group : {"g0", "g1", "g2"}) {
    expectTrue(restored.topK(group) == op.topK(group),
               "final topK matches for " + group);
  }
}

void testSnapshotDuringPendingUpdate() {
  TopKOperator op(2);
  op.insert({"g", "a", 10});
  op.insert({"g", "b", 20});
  op.updateBefore({"g", "a", 10});  // latched but not yet applied
  const TopKOperator::Snapshot snap = op.snapshot();

  const std::vector<Change> expected = op.updateAfter({"g", "a", 30});

  TopKOperator restored(2);
  restored.insert({"g", "a", 10});
  restored.insert({"g", "b", 20});
  restored.restore(snap);
  expectEq(restored.updateAfter({"g", "a", 30}), expected,
           "pending update_before survives snapshot");
}

}  // namespace

int main() {
  testBasicInsertAndEviction();
  testStableTieBreak();
  testUpdateSameGroup();
  testCrossGroupTransaction();
  testDelete();
  testStrictness();
  testSnapshotRestoreEquivalence();
  testSnapshotDuringPendingUpdate();
  if (failures != 0) {
    std::cerr << failures << " failure(s)\n";
    return EXIT_FAILURE;
  }
  std::cout << "all tests passed\n";
  return EXIT_SUCCESS;
}
