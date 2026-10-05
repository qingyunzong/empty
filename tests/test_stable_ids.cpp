#include "test_util.hpp"

#include <memory>
#include <string>
#include <vector>

int main() {
  ser::Registry reg = make_registry();

  // 已知图的精确字节输出: ID 按字段序首访分配 (root=1, 共享子节点=2)。
  {
    Node root, child;
    root.value = 1;
    root.name = "root";
    root.left = &child;
    root.right = &child;
    child.value = 2;
    child.name = "kid";
    const std::string expected =
        "SER1 2\n"
        "O 1 Node\n"
        "I 1\n"
        "S 4 root\n"
        "R 2\n"
        "R 2\n"
        "E\n"
        "O 2 Node\n"
        "I 2\n"
        "S 3 kid\n"
        "R 0\n"
        "R 0\n"
        "E\n";
    REQUIRE(ser::serialize(reg, &root) == expected);
  }

  // BFS 字段序: root(1) -> a(2), b(3); a -> c(4)。不是地址序也不是 DFS 序。
  {
    Node root, a, b, c;
    root.value = 1; root.name = "r";
    a.value = 2;    a.name = "a";
    b.value = 3;    b.name = "b";
    c.value = 4;    c.name = "c";
    root.left = &a;
    root.right = &b;
    a.left = &c;
    const std::string expected =
        "SER1 4\n"
        "O 1 Node\nI 1\nS 1 r\nR 2\nR 3\nE\n"
        "O 2 Node\nI 2\nS 1 a\nR 4\nR 0\nE\n"
        "O 3 Node\nI 3\nS 1 b\nR 0\nR 0\nE\n"
        "O 4 Node\nI 4\nS 1 c\nR 0\nR 0\nE\n";
    REQUIRE(ser::serialize(reg, &root) == expected);
  }

  // 地址无关: 同一逻辑图, 不同分配顺序/地址, 输出字节完全一致。
  {
    auto build = [](bool reverse) {
      std::vector<std::unique_ptr<Node>> keep;
      Node* nodes[4];
      for (int i = 0; i < 4; ++i) {
        auto n = std::make_unique<Node>();
        n->value = i + 1;
        nodes[i] = n.get();
        keep.push_back(std::move(n));
      }
      // reverse 模式下交换堆块所有权顺序, 使地址相对顺序不同。
      if (reverse)
        std::swap(keep[0], keep[3]);
      nodes[0]->left = nodes[1];
      nodes[0]->right = nodes[2];
      nodes[1]->left = nodes[3];
      nodes[2]->right = nodes[3];
      return std::pair{std::move(keep), nodes[0]};
    };
    auto g1 = build(false);
    auto g2 = build(true);
    REQUIRE(ser::serialize(reg, g1.second) == ser::serialize(reg, g2.second));
  }

  // 重复序列化确定性
  {
    Node a, b;
    a.left = &b;
    b.right = &a;
    REQUIRE(ser::serialize(reg, &a) == ser::serialize(reg, &a));
  }
  REQUIRE(Node::live_count == 0);

  std::puts("test_stable_ids OK");
  return 0;
}
