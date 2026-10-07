#include "reduce.hpp"
#include "transform.hpp"

#include <cassert>
#include <iostream>
#include <sstream>

using namespace ar;

static bool contains_crash(const Node& n) {
  return print(n).find("crash") != std::string::npos;
}

static bool has_int_ge_5(const Node& n) {
  if (n.kind == Node::Kind::Int && (n.value >= 5 || n.value <= -5))
    return true;
  for (const Node& c : n.children)
    if (has_int_ge_5(c))
      return true;
  return false;
}

static size_t count_substr(const std::string& hay, const std::string& needle) {
  size_t n = 0, pos = 0;
  while ((pos = hay.find(needle, pos)) != std::string::npos) {
    ++n;
    pos += needle.size();
  }
  return n;
}

int main() {
  Node input = parse("(prog (def f 1 2 3 4) (call g 10 20) (crash 7 8))");

  std::ostringstream trace;
  ReduceResult res = reduce(input, contains_crash, trace);
  assert(!res.limit_hit);
  assert(res.trials > 0);

  // The failure still reproduces on the result...
  assert(contains_crash(res.tree));
  // ...the result is much smaller...
  assert(node_count(res.tree) < node_count(input));
  assert(print(res.tree) == "((crash))");
  // ...and it is 1-minimal: no single local transformation preserves the
  // predicate.
  for (const Candidate& c : enumerate_candidates(res.tree))
    assert(!contains_crash(c.tree));

  // The trace is complete: one line per trial plus a done line.
  std::string t = trace.str();
  assert(count_substr(t, "\"type\":\"trial\"") == res.trials);
  assert(t.find("\"type\":\"done\"") != std::string::npos);
  assert(t.find("\"one_minimal\":true") != std::string::npos);

  // Reduction is deterministic.
  std::ostringstream trace2;
  ReduceResult res2 = reduce(input, contains_crash, trace2);
  assert(print(res2.tree) == print(res.tree));
  assert(res2.trials == res.trials);

  // Integer reduction drives values toward zero, stopping at the smallest
  // value (under halving) that still triggers the failure.
  std::ostringstream trace3;
  ReduceResult r3 = reduce(parse("(f 100)"), has_int_ge_5, trace3);
  assert(print(r3.tree) == "(6)");
  for (const Candidate& c : enumerate_candidates(r3.tree))
    assert(!has_int_ge_5(c.tree));

  // The trial bound makes termination finite: a predicate that rejects
  // everything would otherwise enumerate every candidate of the input.
  ReduceOptions opts;
  opts.max_trials = 3;
  std::ostringstream trace4;
  auto never = [](const Node&) { return false; };
  ReduceResult r4 = reduce(input, never, trace4, opts);
  assert(r4.limit_hit);
  assert(r4.trials == 3);
  assert(r4.tree == input); // nothing was ever accepted
  assert(trace4.str().find("\"one_minimal\":false") != std::string::npos);

  std::cout << "test_reduce: OK\n";
}
