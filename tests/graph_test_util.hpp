// Shared test fixtures: serializable node types, random cyclic graph
// generation, and structural isomorphism checking (aliasing-aware).
#pragma once

#include <graphser/graphser.hpp>

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#define CHECK(cond)                                                            \
  do {                                                                         \
    if (!(cond)) {                                                             \
      std::ostringstream oss;                                                  \
      oss << __FILE__ << ':' << __LINE__ << ": CHECK failed: " #cond;          \
      throw std::runtime_error(oss.str());                                     \
    }                                                                          \
  } while (0)

namespace testutil {

// Live-instance counter shared by all test node types; lets tests prove
// that nothing leaks after failures.
struct TestBase : graphser::Serializable {
  static inline std::atomic<long> live{0};
  TestBase() { ++live; }
  TestBase(const TestBase&) = delete;
  TestBase& operator=(const TestBase&) = delete;
  ~TestBase() override { --live; }
};

// Injection knobs for failure tests.
struct Injection {
  // When >= 0, decremented on every ListNode::read_fields call; throws
  // std::runtime_error when it reaches 0.
  static inline std::atomic<long> read_fail_countdown{-1};
};

struct PairNode final : TestBase {
  std::int64_t value = 0;
  std::shared_ptr<TestBase> a;
  std::shared_ptr<TestBase> b;

  std::string_view type_tag() const noexcept override { return "pair"; }
  void write_fields(graphser::FieldWriter& w) const override {
    w.i64(value);
    w.ref(a);
    w.ref(b);
  }
  void read_fields(graphser::FieldReader& r) override {
    value = r.i64();
    r.ref(a);
    r.ref(b);
  }
  void break_cycles() noexcept override {
    a.reset();
    b.reset();
  }
};

struct ListNode final : TestBase {
  std::string name;
  std::shared_ptr<TestBase> next;
  std::shared_ptr<TestBase> shared;

  std::string_view type_tag() const noexcept override { return "list"; }
  void write_fields(graphser::FieldWriter& w) const override {
    w.str(name);
    w.ref(next);
    w.ref(shared);
  }
  void read_fields(graphser::FieldReader& r) override {
    if (Injection::read_fail_countdown.load() >= 0 &&
        Injection::read_fail_countdown.fetch_sub(1) == 0)
      throw std::runtime_error("injected read_fields failure");
    name = r.str();
    r.ref(next);
    r.ref(shared);
  }
  void break_cycles() noexcept override {
    next.reset();
    shared.reset();
  }
};

struct Leaf final : TestBase {
  std::uint32_t x = 0;
  std::string label;
  double weight = 0.0;

  std::string_view type_tag() const noexcept override { return "leaf"; }
  void write_fields(graphser::FieldWriter& w) const override {
    w.u32(x);
    w.str(label);
    w.f64(weight);
  }
  void read_fields(graphser::FieldReader& r) override {
    x = r.u32();
    label = r.str();
    weight = r.f64();
  }
  void break_cycles() noexcept override {}
};

inline graphser::TypeRegistry make_registry() {
  graphser::TypeRegistry reg;
  reg.register_type<PairNode>("pair");
  reg.register_type<ListNode>("list");
  reg.register_type<Leaf>("leaf");
  return reg;
}

// ---------------------------------------------------------------------------
// Random cyclic graph generation.
// ---------------------------------------------------------------------------

struct RandomGraph {
  std::vector<std::shared_ptr<TestBase>> nodes;
  std::shared_ptr<TestBase> root;
};

inline RandomGraph make_random_graph(std::mt19937_64& rng, std::size_t n) {
  RandomGraph g;
  g.nodes.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    switch (rng() % 3) {
    case 0: {
      auto p = std::make_shared<PairNode>();
      p->value = static_cast<std::int64_t>(rng());
      g.nodes.push_back(std::move(p));
      break;
    }
    case 1: {
      auto l = std::make_shared<ListNode>();
      l->name = "node-" + std::to_string(i) + "-" + std::to_string(rng() % 7);
      g.nodes.push_back(std::move(l));
      break;
    }
    default: {
      auto f = std::make_shared<Leaf>();
      f->x = static_cast<std::uint32_t>(rng());
      f->label = "leaf-" + std::to_string(rng() % 11);
      f->weight = static_cast<double>(rng() % 1000) / 8.0;
      g.nodes.push_back(std::move(f));
      break;
    }
    }
  }
  auto pick = [&]() -> std::shared_ptr<TestBase> {
    if ((rng() % 100) < 15)
      return nullptr; // 15% null refs
    return g.nodes[rng() % g.nodes.size()];
  };
  for (auto& node : g.nodes) {
    if (auto* p = dynamic_cast<PairNode*>(node.get())) {
      p->a = pick();
      p->b = pick();
    } else if (auto* l = dynamic_cast<ListNode*>(node.get())) {
      l->next = pick();
      l->shared = pick();
    }
  }
  g.root = g.nodes.front();
  return g;
}

// ---------------------------------------------------------------------------
// Aliasing-aware structural comparison. Walks both graphs simultaneously in
// field order; a node already seen on the left must map to the exact same
// node on the right (preserves sharing and cycles, rejects spurious
// duplication or merging).
// ---------------------------------------------------------------------------

inline void expect_isomorphic(const std::shared_ptr<const TestBase>& x,
                              const std::shared_ptr<const TestBase>& y) {
  std::map<const TestBase*, const TestBase*> seen;
  std::vector<std::pair<const TestBase*, const TestBase*>> stack;
  stack.emplace_back(x.get(), y.get());
  while (!stack.empty()) {
    auto [a, b] = stack.back();
    stack.pop_back();
    if (a == nullptr || b == nullptr) {
      CHECK(a == b);
      continue;
    }
    auto [it, inserted] = seen.emplace(a, b);
    if (!inserted) {
      CHECK(it->second == b); // aliasing must match exactly
      continue;
    }
    CHECK(typeid(*a) == typeid(*b));
    if (auto* pa = dynamic_cast<const PairNode*>(a)) {
      auto* pb = static_cast<const PairNode*>(b);
      CHECK(pa->value == pb->value);
      stack.emplace_back(pa->a.get(), pb->a.get());
      stack.emplace_back(pa->b.get(), pb->b.get());
    } else if (auto* la = dynamic_cast<const ListNode*>(a)) {
      auto* lb = static_cast<const ListNode*>(b);
      CHECK(la->name == lb->name);
      stack.emplace_back(la->next.get(), lb->next.get());
      stack.emplace_back(la->shared.get(), lb->shared.get());
    } else if (auto* fa = dynamic_cast<const Leaf*>(a)) {
      auto* fb = static_cast<const Leaf*>(b);
      CHECK(fa->x == fb->x);
      CHECK(fa->label == fb->label);
      CHECK(fa->weight == fb->weight);
    } else {
      CHECK(false && "unexpected node type");
    }
  }
}

inline std::size_t reachable_count(const std::shared_ptr<const TestBase>& root) {
  std::map<const TestBase*, bool> seen;
  std::vector<const TestBase*> stack{root.get()};
  while (!stack.empty()) {
    const TestBase* n = stack.back();
    stack.pop_back();
    if (!n || !seen.emplace(n, true).second)
      continue;
    if (auto* p = dynamic_cast<const PairNode*>(n)) {
      stack.push_back(p->a.get());
      stack.push_back(p->b.get());
    } else if (auto* l = dynamic_cast<const ListNode*>(n)) {
      stack.push_back(l->next.get());
      stack.push_back(l->shared.get());
    }
  }
  return seen.size();
}

// Dismantles a graph containing shared_ptr cycles: collects every reachable
// node, breaks all reference fields, then releases. Without this, cyclic
// graphs would never be freed (the classic shared_ptr cycle problem).
template <typename T>
inline void destroy_graph(std::shared_ptr<T>& root) {
  if (!root)
    return;
  std::map<TestBase*, bool> seen;
  std::vector<std::shared_ptr<TestBase>> hold;
  std::vector<std::shared_ptr<TestBase>> stack{
      std::static_pointer_cast<TestBase>(root)};
  while (!stack.empty()) {
    std::shared_ptr<TestBase> n = std::move(stack.back());
    stack.pop_back();
    if (!n || !seen.emplace(n.get(), true).second)
      continue;
    if (auto* p = dynamic_cast<PairNode*>(n.get())) {
      stack.push_back(p->a);
      stack.push_back(p->b);
    } else if (auto* l = dynamic_cast<ListNode*>(n.get())) {
      stack.push_back(l->next);
      stack.push_back(l->shared);
    }
    hold.push_back(std::move(n));
  }
  for (auto& n : hold)
    n->break_cycles();
  root.reset();
  hold.clear();
}

// Breaks cycles across an entire node pool (including nodes unreachable
// from the root, which may form cycles of their own), then releases them.
inline void destroy_all(std::vector<std::shared_ptr<TestBase>>& nodes) {
  for (auto& n : nodes)
    n->break_cycles();
  nodes.clear();
}

} // namespace testutil
