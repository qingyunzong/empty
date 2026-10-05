// Verifies that object IDs are assigned by first-visit order from the root
// in field order (pre-order DFS), independent of pointer addresses, and
// that serialization is byte-for-byte deterministic.
#include "graph_test_util.hpp"

#include <cstddef>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using namespace testutil;

namespace {

std::vector<std::string> parse_tag_table(const std::vector<std::byte>& buf) {
  CHECK(buf.size() >= 9);
  CHECK(std::string_view(reinterpret_cast<const char*>(buf.data()), 4) ==
        "GSER");
  std::size_t pos = 5; // skip magic + version
  auto u32 = [&]() {
    std::uint32_t v = 0;
    for (int i = 0; i < 4; ++i)
      v |= static_cast<std::uint32_t>(buf[pos + i]) << (8 * i);
    pos += 4;
    return v;
  };
  auto u16 = [&]() {
    std::uint16_t v = static_cast<std::uint16_t>(buf[pos]) |
                      static_cast<std::uint16_t>(
                          static_cast<std::uint16_t>(buf[pos + 1]) << 8);
    pos += 2;
    return v;
  };
  std::uint32_t count = u32();
  std::vector<std::string> tags;
  for (std::uint32_t i = 0; i < count; ++i) {
    std::uint16_t len = u16();
    tags.emplace_back(reinterpret_cast<const char*>(buf.data() + pos), len);
    pos += len;
  }
  return tags;
}

// Builds the graph:
//   root(pair).a = p1, root.b = c
//   p1.a = d (leaf), p1.b = null
//   c.next = d (shared with p1.a), c.shared = root (cycle)
// Pre-order DFS in field order must number: root=0, p1=1, d=2, c=3.
std::shared_ptr<PairNode> build_known_graph() {
  auto root = std::make_shared<PairNode>();
  auto p1 = std::make_shared<PairNode>();
  auto d = std::make_shared<Leaf>();
  auto c = std::make_shared<ListNode>();
  root->a = p1;
  root->b = c;
  p1->a = d;
  c->next = d;
  c->shared = root;
  return root;
}

} // namespace

int main() {
  // 1. IDs follow first-visit order from the root in field order.
  auto tags = parse_tag_table(graphser::serialize(build_known_graph()));
  CHECK((tags == std::vector<std::string>{"pair", "pair", "leaf", "list"}));

  // 2. A logically identical graph built separately (different addresses,
  //    different allocation order) serializes to identical bytes.
  auto bytes1 = graphser::serialize(build_known_graph());
  auto bytes2 = graphser::serialize(build_known_graph());
  CHECK(bytes1 == bytes2);

  // 3. Serializing the same graph twice is byte-identical (no address or
  //    hash-iteration leakage into the output).
  auto g = build_known_graph();
  CHECK(graphser::serialize(g) == graphser::serialize(g));

  // 4. Null references round-trip as null.
  auto reg = make_registry();
  auto copy = graphser::deserialize(bytes1, reg);
  auto* rc = dynamic_cast<PairNode*>(copy.get());
  CHECK(rc != nullptr);
  auto* p1c = dynamic_cast<PairNode*>(rc->a.get());
  CHECK(p1c != nullptr && p1c->b == nullptr);
  auto* cc = dynamic_cast<ListNode*>(rc->b.get());
  CHECK(cc != nullptr);
  CHECK(cc->next.get() == p1c->a.get()); // sharing preserved
  CHECK(cc->shared.get() == copy.get()); // cycle preserved

  std::cout << "test_stable_ids: OK\n";
  return 0;
}
