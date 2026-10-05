#include "test_util.hpp"

#include <memory>
#include <string>
#include <vector>

namespace {

template <typename Ex, typename F>
bool throws(F&& f) {
  try {
    f();
  } catch (const Ex&) {
    return true;
  } catch (...) {
    return false;
  }
  return false;
}

// 构造一个 5 节点带环图的有效序列化字节流。
std::string make_valid_stream(ser::Registry& reg, std::vector<std::unique_ptr<Node>>& keep) {
  for (int i = 0; i < 5; ++i) {
    auto n = std::make_unique<Node>();
    n->value = i;
    n->name = "n" + std::to_string(i);
    keep.push_back(std::move(n));
  }
  for (int i = 0; i < 5; ++i)
    keep[i]->left = keep[(i + 1) % 5].get();
  keep[0]->right = keep[2].get();
  return ser::serialize(reg, keep[0].get());
}

}  // namespace

int main() {
  // 1. 未知类型被拒绝, 且已构造对象全部释放。
  {
    ser::Registry reg = make_registry();
    std::vector<std::unique_ptr<Node>> keep;
    std::string data = make_valid_stream(reg, keep);
    const int baseline = Node::live_count;  // keep 持有的原始节点
    const std::size_t pos = data.find("Node");
    REQUIRE(pos != std::string::npos);
    data.replace(pos, 4, "Evil");
    REQUIRE(throws<ser::UnknownTypeError>([&] { ser::deserialize(reg, data); }));
    REQUIRE(Node::live_count == baseline);
  }

  // 2. 序列化未注册类型被拒绝。
  {
    ser::Registry reg;
    reg.add<Node>("Node");
    Leaf leaf;
    REQUIRE(throws<ser::Error>([&] { ser::serialize(reg, &leaf); }));
  }

  // 3. 构造失败注入: 在每一次构造点注入失败, 均无泄漏; 不注入时成功。
  {
    int constructed = 0;
    int fail_after = -1;  // -1 表示不注入
    ser::Registry reg;
    reg.add_factory("Node", typeid(Node),
                    [&]() -> std::unique_ptr<ser::Serializable> {
                      if (fail_after >= 0 && constructed >= fail_after)
                        throw std::runtime_error("injected construction failure");
                      ++constructed;
                      return std::make_unique<Node>();
                    });
    reg.add<Leaf>("Leaf");

    std::vector<std::unique_ptr<Node>> keep;
    ser::Registry plain = make_registry();
    const std::string data = make_valid_stream(plain, keep);
    const int baseline = Node::live_count;

    for (int k = 0; k < 5; ++k) {
      constructed = 0;
      fail_after = k;
      REQUIRE(throws<std::runtime_error>([&] { ser::deserialize(reg, data); }));
      REQUIRE(Node::live_count == baseline);  // 已构造的 k 个对象全部释放
    }
    constructed = 0;
    fail_after = -1;
    {
      ser::Graph g = ser::deserialize(reg, data);
      REQUIRE(g.size() == 5);
      REQUIRE(Node::live_count == baseline + 5);
      REQUIRE(g.root_as<Node>()->left->left->left->left->left ==
              g.root_as<Node>());
    }
    REQUIRE(Node::live_count == baseline);
  }

  // 4. 悬空引用 ID。
  {
    ser::Registry reg = make_registry();
    std::vector<std::unique_ptr<Node>> keep;
    std::string data = make_valid_stream(reg, keep);
    const int baseline = Node::live_count;
    const std::size_t pos = data.find("R 1\n");
    REQUIRE(pos != std::string::npos);
    data.replace(pos, 4, "R 9\n");
    REQUIRE(throws<ser::FormatError>([&] { ser::deserialize(reg, data); }));
    REQUIRE(Node::live_count == baseline);
  }

  // 5. 引用类型不匹配 (Node.left 指向 Leaf 对象)。
  {
    ser::Registry reg = make_registry();
    const std::string data =
        "SER1 2\n"
        "O 1 Leaf\n"
        "I 7\n"
        "E\n"
        "O 2 Node\n"
        "I 1\n"
        "S 1 x\n"
        "R 1\n"
        "R 0\n"
        "E\n";
    REQUIRE(throws<ser::FormatError>([&] { ser::deserialize(reg, data); }));
    REQUIRE(Node::live_count == 0);
    REQUIRE(Leaf::live_count == 0);
  }

  // 6. 截断输入 (每个前缀都必须失败且无泄漏)。
  {
    ser::Registry reg = make_registry();
    std::vector<std::unique_ptr<Node>> keep;
    const std::string data = make_valid_stream(reg, keep);
    const int baseline = Node::live_count;
    // 注意: 末尾换行属于可选空白, 故截断点需落在有效负载内。
    for (std::size_t cut : {data.size() / 2, data.size() - 2, std::size_t{5}}) {
      REQUIRE(throws<ser::Error>(
          [&] { ser::deserialize(reg, data.substr(0, cut)); }));
      REQUIRE(Node::live_count == baseline);
    }
  }

  // 7. 其它格式错误: 坏魔数 / 尾部垃圾 / 非顺序 ID / 荒谬计数。
  {
    ser::Registry reg = make_registry();
    std::vector<std::unique_ptr<Node>> keep;
    const std::string valid = make_valid_stream(reg, keep);
    const int baseline = Node::live_count;

    REQUIRE(throws<ser::FormatError>([&] { ser::deserialize(reg, "XYZ 1\n"); }));

    REQUIRE(throws<ser::FormatError>(
        [&] { ser::deserialize(reg, valid + "junk\n"); }));

    std::string bad_id = valid;
    const std::size_t pos = bad_id.find("O 2 ");
    REQUIRE(pos != std::string::npos);
    bad_id.replace(pos, 4, "O 3 ");
    REQUIRE(throws<ser::FormatError>([&] { ser::deserialize(reg, bad_id); }));

    REQUIRE(throws<ser::FormatError>(
        [&] { ser::deserialize(reg, "SER1 999999999\n"); }));

    REQUIRE(Node::live_count == baseline);
  }

  std::puts("test_errors OK");
  return 0;
}
