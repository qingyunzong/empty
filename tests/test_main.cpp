// Test executable; each CTest case is a subcommand:
//   reducer_tests <case>

#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "reducer.hpp"

using namespace reducer;

#define CHECK(cond)                                                            \
  do {                                                                         \
    if (!(cond)) {                                                             \
      std::cerr << "CHECK failed: " #cond " (" << __FILE__ << ":" << __LINE__  \
                << ")\n";                                                      \
      return 1;                                                                \
    }                                                                          \
  } while (0)

static bool contains(const std::vector<Node>& v, const Node& n) {
  for (const auto& x : v)
    if (x == n) return true;
  return false;
}

// Parser/printer round-trip and syntactic validity.
static int test_roundtrip() {
  const std::string src = "(seq (add 1 -2) (mul 3 (div 8 0)) (sub 5 5))";
  const Node n = parse(src);
  CHECK(print_ast(n) == src);
  CHECK(parse(print_ast(n)) == n);
  CHECK(ast_size(n) == 17);
  bool threw = false;
  try {
    (void)parse("(add 1");
  } catch (const ParseError&) {
    threw = true;
  }
  CHECK(threw);
  return 0;
}

// Each transformation yields syntactically valid, smaller candidates.
static int test_transforms() {
  const Node prog = parse("(seq (add 8 3) (div 4 0) 7)");

  const auto ints = shrink_ints(prog);
  CHECK(contains(ints, parse("(seq (add 4 3) (div 4 0) 7)")));
  CHECK(contains(ints, parse("(seq (add 0 3) (div 4 0) 7)")));
  CHECK(contains(ints, parse("(seq (add 8 3) (div 2 0) 7)")));

  const auto dels = delete_nodes(prog);
  CHECK(contains(dels, parse("(add 8 3)")));   // replace root by child
  CHECK(contains(dels, parse("(div 4 0)")));
  CHECK(contains(dels, parse("(seq 8 (div 4 0) 7)"))); // nested replacement

  const auto shorts = shorten_lists(prog);
  CHECK(contains(shorts, parse("(seq (div 4 0) 7)")));      // drop one element
  CHECK(contains(shorts, parse("(seq (add 8 3) (div 4 0))")));

  for (const Transform tf : {shrink_ints, delete_nodes, shorten_lists})
    for (const Node& c : tf(prog)) {
      CHECK(program_cost(c) < program_cost(prog)); // strictly decreasing
      CHECK(parse(print_ast(c)) == c); // every step syntactically valid
    }
  return 0;
}

// Reduction reaches a local minimum and the failure genuinely reproduces.
static int test_reduce_minimality() {
  const Node initial = parse("(seq (add 1 2) (mul 3 4) (div 8 0) (sub 5 5))");
  CHECK(reproduces_crash(initial));
  Reducer r(reproduces_crash, "test-env");
  const ReduceResult rr = r.reduce(initial);
  CHECK(print_ast(rr.result) == "(div 0 0)");
  CHECK(reproduces_crash(rr.result)); // failure still reproduces
  CHECK(is_local_minimum(rr.result, reproduces_crash));
  CHECK(!is_local_minimum(initial, reproduces_crash));

  // A non-crashing input must be rejected up front.
  bool threw = false;
  try {
    Reducer r2(reproduces_crash, "test-env");
    (void)r2.reduce(parse("(add 1 2)"));
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
  return 0;
}

// Cache keys include the execution environment id; caching dedupes queries.
static int test_cache_env() {
  const Node n = parse("(div 1 0)");
  Reducer a(reproduces_crash, "env-A");
  Reducer b(reproduces_crash, "env-B");
  Reducer a2(reproduces_crash, "env-A");
  CHECK(a.cache_key(n) != b.cache_key(n));
  CHECK(a.cache_key(n) == a2.cache_key(n));
  CHECK(a.cache_key(n).find("env-A") == 0);

  // Same candidate reached via different paths must hit the cache.
  size_t evals = 0;
  auto counting = [&](const Node& m) {
    ++evals;
    return reproduces_crash(m);
  };
  Reducer r(counting, "env-C");
  const ReduceResult rr = r.reduce(parse("(div 2 0)"));
  CHECK(print_ast(rr.result) == "(div 0 0)");
  CHECK(rr.cache_hits >= 1);
  CHECK(evals + rr.cache_hits == rr.trajectory.size());
  return 0;
}

// The trajectory records every trial, in order, with valid candidates.
static int test_trajectory() {
  const Node initial = parse("(seq (add 1 2) (mul 3 4) (div 8 0) (sub 5 5))");
  Reducer r(reproduces_crash, "traj-env");
  const ReduceResult rr = r.reduce(initial);
  CHECK(!rr.trajectory.empty());
  CHECK(rr.env_id == "traj-env");
  CHECK(rr.trajectory.front().transform == "initial");
  CHECK(rr.trajectory.front().accepted);

  for (size_t i = 0; i < rr.trajectory.size(); ++i) {
    const Trial& t = rr.trajectory[i];
    CHECK(t.step == i);
    Node reparsed = Node::integer(0);
    try {
      reparsed = parse(t.candidate);
    } catch (...) {
      CHECK(false && "trial candidate is not syntactically valid");
    }
    CHECK(ast_size(reparsed) == t.candidate_size);
    CHECK(t.candidate_cost == program_cost(reparsed));
    if (!t.accepted) CHECK(!t.bad || t.candidate_cost >= program_cost(rr.result));
  }

  // Accepted steps form a strictly decreasing chain ending at the result.
  uint64_t last_cost = program_cost(initial) + 1;
  std::string last_text;
  for (const Trial& t : rr.trajectory) {
    if (!t.accepted) continue;
    CHECK(t.candidate_cost < last_cost);
    last_cost = t.candidate_cost;
    last_text = t.candidate;
  }
  CHECK(last_text == print_ast(rr.result));

  const std::string dump = format_trajectory(rr);
  CHECK(dump.find("# env: traj-env") != std::string::npos);
  CHECK(dump.find("| shrink-int |") != std::string::npos);
  return 0;
}

// Bounded bad-predicate verification over finite ASTs.
static int test_bounded_verify() {
  const VerifyReport rep = verify_bounded(reproduces_crash, 5);
  CHECK(rep.ok);
  CHECK(rep.asts_checked > 1000);
  if (!rep.ok) std::cerr << rep.error << '\n';

  // Sanity: enumeration contains both crashing and non-crashing ASTs.
  bool any_bad = false, any_good = false;
  for (const Node& a : enumerate_asts(3))
    (reproduces_crash(a) ? any_bad : any_good) = true;
  CHECK(any_bad && any_good);
  return 0;
}

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: reducer_tests <case>\n";
    return 2;
  }
  const std::string name = argv[1];
  if (name == "roundtrip") return test_roundtrip();
  if (name == "transforms") return test_transforms();
  if (name == "reduce_minimality") return test_reduce_minimality();
  if (name == "cache_env") return test_cache_env();
  if (name == "trajectory") return test_trajectory();
  if (name == "bounded_verify") return test_bounded_verify();
  std::cerr << "unknown test case: " << name << '\n';
  return 2;
}
