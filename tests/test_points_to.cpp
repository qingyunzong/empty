#include "pta/points_to.hpp"

#include <cstdlib>
#include <iostream>
#include <map>
#include <string>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": " #cond      \
                << "\n";                                                     \
      ++failures;                                                            \
    }                                                                        \
  } while (0)

using pta::Analyzer;
using pta::Statement;

// 基本赋值：p = new A; q = p; r = &x;
void test_copy_and_alloc() {
  Analyzer a;
  a.add(Statement::alloc("p", "A"));
  a.add(Statement::copy("q", "p"));
  a.add(Statement::addr_of("r", "x"));
  a.solve();

  CHECK(a.state().points_to("p") == std::set<std::string>{"alloc:A"});
  CHECK(a.state().points_to("q") == std::set<std::string>{"alloc:A"});
  CHECK(a.state().points_to("r") == std::set<std::string>{"stack:x"});
  // 最小性：无关变量没有 points-to 信息。
  CHECK(a.state().points_to("z").empty());
}

// 字段读写：p->f = q; r = p->f;
void test_field_store_load() {
  Analyzer a;
  a.add(Statement::alloc("p", "A"));
  a.add(Statement::alloc("q", "B"));
  a.add(Statement::store("p", "f", "q"));
  a.add(Statement::load("r", "p", "f"));
  a.solve();

  CHECK(a.state().points_to("r") == std::set<std::string>{"alloc:B"});
  CHECK(a.state().field_points_to("alloc:A", "f") ==
        std::set<std::string>{"alloc:B"});
  // 最小性：未写过的字段为空。
  CHECK(a.state().field_points_to("alloc:A", "g").empty());
  CHECK(a.state().field_points_to("alloc:B", "f").empty());
}

// 循环结构（自引用链表）上的不动点求解必须终止且收敛。
void test_fixpoint_cycle() {
  Analyzer a;
  a.add(Statement::alloc("p", "A"));
  a.add(Statement::store("p", "next", "p")); // p->next = p
  a.add(Statement::load("q", "p", "next"));  // q = p->next
  a.add(Statement::store("q", "next", "q")); // q->next = q
  const std::size_t rounds = a.solve();

  CHECK(rounds >= 2); // 至少需要两轮才收敛
  CHECK(a.state().points_to("q") == std::set<std::string>{"alloc:A"});
  CHECK(a.state().field_points_to("alloc:A", "next") ==
        std::set<std::string>{"alloc:A"});
}

// 堆对象按分配点区分：同一变量在不同路径上指向不同分配点，
// 通过其中一个的字段写不能污染另一个。
void test_alloc_site_distinction() {
  Analyzer a;
  a.add(Statement::alloc("p", "A1"));
  a.add(Statement::alloc("p", "A2")); // p -> {A1, A2}
  a.add(Statement::alloc("x", "B"));
  a.add(Statement::store("p", "f", "x"));
  a.add(Statement::load("r", "p", "f"));
  a.solve();

  CHECK(a.state().points_to("p") ==
        std::set<std::string>({"alloc:A1", "alloc:A2"}));
  CHECK(a.state().field_points_to("alloc:A1", "f") ==
        std::set<std::string>{"alloc:B"});
  CHECK(a.state().field_points_to("alloc:A2", "f") ==
        std::set<std::string>{"alloc:B"});
  CHECK(a.state().points_to("r") == std::set<std::string>{"alloc:B"});
}

// 删除语句后重算：不能保留无支撑别名，且与从空重算完全一致。
void test_deletion_consistency() {
  Analyzer a;
  const auto alloc_p = a.add(Statement::alloc("p", "A"));
  const auto alloc_q = a.add(Statement::alloc("q", "B"));
  const auto copy_q_p = a.add(Statement::copy("q", "p"));
  const auto store_p_f_q = a.add(Statement::store("p", "f", "q"));
  const auto load_r = a.add(Statement::load("r", "p", "f"));
  (void)alloc_p;
  (void)alloc_q;
  (void)load_r;
  a.solve();

  // 删除前：q -> {A, B}，r -> {A, B}
  CHECK(a.state().points_to("q") ==
        std::set<std::string>({"alloc:A", "alloc:B"}));
  CHECK(a.state().points_to("r") ==
        std::set<std::string>({"alloc:A", "alloc:B"}));

  // 删除 q = p 与 p->f = q 的支撑语句。
  CHECK(a.remove(copy_q_p));
  CHECK(a.remove(store_p_f_q));
  a.solve();

  // 无支撑别名必须消失：q 只剩 {B}，r 为空。
  CHECK(a.state().points_to("q") == std::set<std::string>{"alloc:B"});
  CHECK(a.state().points_to("r").empty());
  CHECK(a.state().field_points_to("alloc:A", "f").empty());

  // 与从空重算（全新 Analyzer 只含剩余语句）对照，必须完全一致。
  Analyzer fresh;
  for (const auto& stmt : a.statements())
    fresh.add(stmt);
  fresh.solve();
  CHECK(a.state() == fresh.state());
}

// 删除全部语句后状态必须回到空。
void test_delete_all() {
  Analyzer a;
  std::vector<Analyzer::StmtId> ids;
  ids.push_back(a.add(Statement::alloc("p", "A")));
  ids.push_back(a.add(Statement::copy("q", "p")));
  ids.push_back(a.add(Statement::store("p", "f", "q")));
  a.solve();
  CHECK(!a.state().points_to("q").empty());

  for (const auto id : ids)
    CHECK(a.remove(id));
  a.solve();

  CHECK(a.state() == pta::PointsToState{});
  // 重复删除应失败。
  CHECK(!a.remove(ids[0]));
}

const std::map<std::string, void (*)()> kTests = {
    {"copy_and_alloc", test_copy_and_alloc},
    {"field_store_load", test_field_store_load},
    {"fixpoint_cycle", test_fixpoint_cycle},
    {"alloc_site_distinction", test_alloc_site_distinction},
    {"deletion_consistency", test_deletion_consistency},
    {"delete_all", test_delete_all},
};

} // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: " << argv[0] << " <test-name>\n";
    return 2;
  }
  const auto it = kTests.find(argv[1]);
  if (it == kTests.end()) {
    std::cerr << "unknown test: " << argv[1] << "\n";
    return 2;
  }
  it->second();
  if (failures == 0) {
    std::cout << "PASS " << argv[1] << "\n";
    return 0;
  }
  std::cout << "FAILED " << argv[1] << " (" << failures << " checks)\n";
  return 1;
}
