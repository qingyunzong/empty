#include "test_util.hpp"

int main() {
  ser::Registry reg = make_registry();

  // 菱形共享: root->left == root->right
  {
    Node root, child;
    root.value = 1;
    child.value = 2;
    root.left = &child;
    root.right = &child;
    ser::Graph g = ser::deserialize(reg, ser::serialize(reg, &root));
    auto* r = g.root_as<Node>();
    REQUIRE(g.size() == 2);
    REQUIRE(r->left != nullptr);
    REQUIRE(r->left == r->right);
    REQUIRE(r->left->value == 2);
  }
  REQUIRE(Node::live_count == 0);

  // 自环
  {
    Node n;
    n.value = 7;
    n.left = &n;
    ser::Graph g = ser::deserialize(reg, ser::serialize(reg, &n));
    auto* r = g.root_as<Node>();
    REQUIRE(g.size() == 1);
    REQUIRE(r->left == r);
    REQUIRE(r->right == nullptr);
  }
  REQUIRE(Node::live_count == 0);

  // 双节点互环
  {
    Node a, b;
    a.value = 1;
    b.value = 2;
    a.left = &b;
    b.left = &a;
    ser::Graph g = ser::deserialize(reg, ser::serialize(reg, &a));
    auto* r = g.root_as<Node>();
    REQUIRE(g.size() == 2);
    REQUIRE(r->left->left == r);
    REQUIRE(r->left->value == 2);
  }
  REQUIRE(Node::live_count == 0);

  // 三节点环 + 共享尾
  {
    Node a, b, c, shared;
    a.left = &b;
    b.left = &c;
    c.left = &a;
    a.right = &shared;
    b.right = &shared;
    c.right = &shared;
    shared.value = 99;
    ser::Graph g = ser::deserialize(reg, ser::serialize(reg, &a));
    auto* r = g.root_as<Node>();
    REQUIRE(g.size() == 4);
    REQUIRE(r->left->left->left == r);
    REQUIRE(r->right == r->left->right);
    REQUIRE(r->right == r->left->left->right);
    REQUIRE(r->right->value == 99);
  }
  REQUIRE(Node::live_count == 0);

  std::puts("test_sharing_cycles OK");
  return 0;
}
