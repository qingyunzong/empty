// Failure-injection tests: unknown types are rejected, and every failure
// path (unknown tag, throwing factory, throwing read_fields, corrupt
// buffers) releases all partially constructed objects - even when
// reference cycles were already formed.
//
// Leak detection is twofold:
//   1. TestBase::live counts live node instances.
//   2. Global operator new/delete counting proves allocation balance
//      (catches leaks of any heap object, not just nodes).
#include "graph_test_util.hpp"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <new>
#include <random>

using namespace testutil;

namespace {

std::atomic<long> g_alloc_balance{0};

} // namespace

void* operator new(std::size_t n) {
  g_alloc_balance.fetch_add(1, std::memory_order_relaxed);
  if (void* p = std::malloc(n == 0 ? 1 : n))
    return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept {
  if (p)
    g_alloc_balance.fetch_sub(1, std::memory_order_relaxed);
  std::free(p);
}
void operator delete(void* p, std::size_t) noexcept { operator delete(p); }

namespace {

// Minimal buffer builder matching the documented wire format.
struct Buf {
  std::vector<std::byte> b;
  void raw(std::string_view s) {
    for (char c : s)
      b.push_back(static_cast<std::byte>(c));
  }
  void u8(std::uint8_t v) { b.push_back(static_cast<std::byte>(v)); }
  void u16(std::uint16_t v) {
    u8(static_cast<std::uint8_t>(v & 0xFF));
    u8(static_cast<std::uint8_t>(v >> 8));
  }
  void u32(std::uint32_t v) {
    for (unsigned s = 0; s < 32; s += 8)
      u8(static_cast<std::uint8_t>((v >> s) & 0xFF));
  }
  void u64(std::uint64_t v) {
    for (unsigned s = 0; s < 64; s += 8)
      u8(static_cast<std::uint8_t>((v >> s) & 0xFF));
  }
  void tag(std::string_view t) {
    u16(static_cast<std::uint16_t>(t.size()));
    raw(t);
  }
  void header(std::uint32_t count) {
    raw("GSER");
    u8(1);
    u32(count);
  }
};

template <typename F>
void expect_throws(F&& f) {
  bool threw = false;
  try {
    f();
  } catch (...) {
    threw = true;
  }
  CHECK(threw);
}

// Graph whose deserialization forms a cycle (obj0 <-> obj1) before the
// last object (a ListNode, id 2) is populated - used to inject a
// read_fields failure while cycles exist.
std::shared_ptr<PairNode> make_cycle_trigger_graph() {
  auto p0 = std::make_shared<PairNode>();
  auto p1 = std::make_shared<PairNode>();
  auto l0 = std::make_shared<ListNode>();
  p0->a = p1;
  p0->b = l0;
  p1->a = p0; // cycle p0 <-> p1
  l0->next = p1;
  l0->shared = p0;
  return p0;
}

} // namespace

int main() {
  auto reg = make_registry();

  // Warm up lazy allocations (iostreams, registry internals, first
  // round-trip) before taking the allocation baseline.
  {
    auto g = make_cycle_trigger_graph();
    auto bytes = graphser::serialize(g);
    auto copy = graphser::deserialize(bytes, reg);
    CHECK(copy != nullptr);
    auto copy_typed = std::dynamic_pointer_cast<TestBase>(copy);
    destroy_graph(copy_typed);
    destroy_graph(g);
  }
  std::cout << "warmup complete\n";

  const long alloc_baseline = g_alloc_balance.load();
  const long live_baseline = TestBase::live.load();

  // 1. Unknown type tag is rejected with unknown_type_error.
  {
    Buf buf;
    buf.header(1);
    buf.tag("nope");
    bool got_unknown = false;
    try {
      (void)graphser::deserialize(buf.b, reg);
    } catch (const graphser::unknown_type_error&) {
      got_unknown = true;
    }
    CHECK(got_unknown);
  }

  // 2. Factory throws on the second creation: the first object must be
  //    released.
  {
    graphser::TypeRegistry reg2 = reg;
    int calls = 0;
    reg2.register_factory(
        "boom", [&calls]() -> std::shared_ptr<graphser::Serializable> {
          if (++calls == 2)
            throw std::runtime_error("injected factory failure");
          return std::make_shared<Leaf>();
        });
    Buf buf;
    buf.header(2);
    buf.tag("boom");
    buf.tag("boom");
    expect_throws([&] { (void)graphser::deserialize(buf.b, reg2); });
    CHECK(calls == 2);
  }

  // 3. read_fields throws after reference cycles have been formed: every
  //    object must be released (break_cycles path).
  {
    std::vector<std::byte> bytes;
    {
      auto g = make_cycle_trigger_graph();
      bytes = graphser::serialize(g);
      destroy_graph(g);
    }
    Injection::read_fail_countdown.store(0); // first ListNode read throws
    expect_throws([&] { (void)graphser::deserialize(bytes, reg); });
    Injection::read_fail_countdown.store(-1);
    CHECK(TestBase::live.load() == live_baseline);
    // The same buffer still deserializes fine afterwards.
    auto ok = graphser::deserialize(bytes, reg);
    CHECK(ok != nullptr);
    auto ok_typed = std::dynamic_pointer_cast<TestBase>(ok);
    destroy_graph(ok_typed);
  }

  // 4. Truncated buffer is rejected.
  {
    auto g = make_cycle_trigger_graph();
    auto bytes = graphser::serialize(g);
    destroy_graph(g);
    bytes.resize(bytes.size() / 2);
    expect_throws([&] { (void)graphser::deserialize(bytes, reg); });
  }

  // 5. Reference id out of range is rejected.
  {
    Buf buf;
    buf.header(1);
    buf.tag("pair");
    buf.u64(42);                    // value
    buf.u32(7);                     // ref a: out of range
    buf.u32(graphser::null_id);     // ref b: null
    buf.u32(0);                     // root id
    expect_throws([&] { (void)graphser::deserialize(buf.b, reg); });
  }

  // 6. Absurd object count is rejected without huge allocation.
  {
    Buf buf;
    buf.header(0xFFFFFFFFu);
    expect_throws([&] { (void)graphser::deserialize(buf.b, reg); });
  }

  // 7. Trailing garbage after a valid graph is rejected.
  {
    auto g = make_cycle_trigger_graph();
    auto bytes = graphser::serialize(g);
    destroy_graph(g);
    bytes.push_back(std::byte{0xAB});
    expect_throws([&] { (void)graphser::deserialize(bytes, reg); });
  }

  // 8. Bad magic / unsupported version are rejected.
  {
    Buf buf;
    buf.raw("XXXX");
    buf.u8(1);
    buf.u32(0);
    expect_throws([&] { (void)graphser::deserialize(buf.b, reg); });

    Buf buf2;
    buf2.raw("GSER");
    buf2.u8(99);
    expect_throws([&] { (void)graphser::deserialize(buf2.b, reg); });
  }

  // No node instances and no heap allocations may have leaked.
  CHECK(TestBase::live.load() == live_baseline);
  CHECK(g_alloc_balance.load() == alloc_baseline);

  std::cout << "test_failure: OK (8 failure cases, no leaks)\n";
  return 0;
}
