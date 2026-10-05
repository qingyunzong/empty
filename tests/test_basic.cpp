#include "test_util.hpp"

#include <string>

int main() {
  ser::Registry reg = make_registry();

  // 空图
  {
    REQUIRE(ser::serialize(reg, nullptr) == "SER1 0\n");
    ser::Graph g = ser::deserialize(reg, "SER1 0\n");
    REQUIRE(g.root() == nullptr);
    REQUIRE(g.size() == 0);
  }

  // 单节点: 负整数 / 含空格换行与 NUL 的字符串
  {
    Node n;
    n.value = -42;
    n.name = std::string("a b\nc\0d", 6);
    const std::string data = ser::serialize(reg, &n);
    ser::Graph g = ser::deserialize(reg, data);
    auto* out = g.root_as<Node>();
    REQUIRE(out != nullptr);
    REQUIRE(out->value == -42);
    REQUIRE(out->name == n.name);
    REQUIRE(out->left == nullptr);
    REQUIRE(out->right == nullptr);
  }
  REQUIRE(Node::live_count == 0);

  // 极值整数
  {
    Node n;
    n.value = INT64_MIN;
    ser::Graph g = ser::deserialize(reg, ser::serialize(reg, &n));
    REQUIRE(g.root_as<Node>()->value == INT64_MIN);
  }
  REQUIRE(Node::live_count == 0);

  std::puts("test_basic OK");
  return 0;
}
