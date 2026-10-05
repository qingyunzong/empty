// Random cyclic graph round-trips: serialize -> deserialize -> verify
// structural isomorphism including aliasing, sharing and cycles.
#include "graph_test_util.hpp"

#include <iostream>
#include <random>

using namespace testutil;

int main() {
  auto reg = make_registry();
  const long baseline = TestBase::live.load();

  const std::size_t sizes[] = {1, 2, 3, 5, 10, 40, 150};
  std::size_t cases = 0;
  for (std::uint64_t seed = 1; seed <= 40; ++seed) {
    for (std::size_t n : sizes) {
      std::mt19937_64 rng(seed * 1000 + n);
      auto g = make_random_graph(rng, n);

      auto bytes = graphser::serialize(g.root);
      // Deterministic: same graph serializes identically every time.
      CHECK(graphser::serialize(g.root) == bytes);

      auto copy = graphser::deserialize(bytes, reg);
      auto typed = std::dynamic_pointer_cast<TestBase>(copy);
      CHECK(typed != nullptr);

      // Same number of distinct reachable objects (no duplication/merging).
      CHECK(reachable_count(g.root) == reachable_count(typed));
      // Data, sharing and cycles all preserved.
      expect_isomorphic(g.root, typed);
      // The copy shares no objects with the original.
      CHECK(typed.get() != g.root.get());
      // Cyclic shared_ptr graphs must be dismantled explicitly.
      destroy_graph(typed);
      destroy_all(g.nodes); // includes nodes unreachable from the root
      g.root.reset();
      ++cases;
    }
  }
  CHECK(TestBase::live.load() == baseline);

  std::cout << "test_roundtrip: OK (" << cases << " random graphs)\n";
  return 0;
}
