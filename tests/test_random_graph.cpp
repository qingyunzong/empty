#include "test_util.hpp"

#include <algorithm>
#include <cstdint>
#include <random>
#include <string>
#include <unordered_set>
#include <vector>

namespace {

std::size_t reachable_count(Node* root) {
  std::unordered_set<Node*> seen;
  std::vector<Node*> stack{root};
  while (!stack.empty()) {
    Node* n = stack.back();
    stack.pop_back();
    if (!n || !seen.insert(n).second)
      continue;
    stack.push_back(n->left);
    stack.push_back(n->right);
  }
  return seen.size();
}

}  // namespace

int main() {
  ser::Registry reg = make_registry();
  std::mt19937_64 rng(20261006);

  for (int iter = 0; iter < 300; ++iter) {
    const int n = 1 + static_cast<int>(rng() % 25);
    std::vector<std::unique_ptr<Node>> keep;
    keep.reserve(n);
    for (int i = 0; i < n; ++i) {
      auto node = std::make_unique<Node>();
      node->value = i;
      node->name = "n" + std::to_string(i) + "_" + std::to_string(rng() % 1000);
      keep.push_back(std::move(node));
    }
    // 随机边: 1/4 概率空, 否则指向随机节点 (允许自环/互环/任意共享)。
    for (auto& node : keep) {
      auto pick = [&]() -> Node* {
        if (rng() % 4 == 0)
          return nullptr;
        return keep[rng() % n].get();
      };
      node->left = pick();
      node->right = pick();
    }
    Node* root = keep[0].get();
    const std::size_t reachable = reachable_count(root);

    const std::string data = ser::serialize(reg, root);
    ser::Graph g = ser::deserialize(reg, data);

    // 对象数 == 原图可达节点数 (不可达节点不序列化)。
    REQUIRE(g.size() == reachable);
    // 别名与结构完整保持: 规范 ID 下再序列化必须字节一致。
    REQUIRE(ser::serialize(reg, g.root()) == data);
    // 反序列化图内部可达性一致。
    REQUIRE(reachable_count(g.root_as<Node>()) == reachable);
    // 显式别名抽查: 反序列化图中同一对象被多处引用时指针必须相同。
    // (随机图中若 left/right 指向同一节点, 字节一致性已强制保证;
    //  这里再直接验证值序列作为数据完整性检查。)
    std::vector<std::int64_t> values;
    for (const auto& obj : g.objects())
      values.push_back(static_cast<Node*>(obj.get())->value);
    std::sort(values.begin(), values.end());
    REQUIRE(std::adjacent_find(values.begin(), values.end()) == values.end());
  }
  REQUIRE(Node::live_count == 0);

  std::puts("test_random_graph OK (300 iterations)");
  return 0;
}
