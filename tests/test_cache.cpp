#include "predicate.hpp"
#include "sha1.hpp"

#include <cassert>
#include <cstdio>
#include <iostream>
#include <unistd.h>

using namespace ar;

int main() {
  // SHA-1 known answer.
  assert(sha1_hex("abc") == "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert(sha1_hex("") == "da39a3ee5e6b4b0d3255bfef95601890afd80709");

  Node t = parse("(a 1)");

  // Environment ID is part of every cache key.
  PredicateCache c1(compute_env_id("oracle-a", "x"));
  PredicateCache c2(compute_env_id("oracle-b", "x")); // different oracle
  PredicateCache c3(compute_env_id("oracle-a", "y")); // different extra tag
  PredicateCache c1b(compute_env_id("oracle-a", "x")); // identical env
  assert(c1.key(t) != c2.key(t));
  assert(c1.key(t) != c3.key(t));
  assert(c1.key(t) == c1b.key(t)); // deterministic

  // Miss, store, hit.
  assert(!c1.lookup(t).has_value());
  assert(c1.misses() == 1 && c1.hits() == 0);
  c1.store(t, true);
  auto v = c1.lookup(t);
  assert(v.has_value() && *v);
  assert(c1.hits() == 1);

  // Persistence: verdicts survive into a fresh cache with the same env id.
  std::string path = "/tmp/ast-reduce-test-cache-" + std::to_string(getpid());
  {
    PredicateCache p1(compute_env_id("oracle-a", "x"));
    p1.enable_persistence(path);
    p1.store(t, false);
  }
  {
    PredicateCache p2(compute_env_id("oracle-a", "x"));
    p2.enable_persistence(path);
    auto got = p2.lookup(t);
    assert(got.has_value() && !*got);
  }
  std::remove(path.c_str());

  std::cout << "test_cache: OK\n";
}
