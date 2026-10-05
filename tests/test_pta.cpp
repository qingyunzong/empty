#include "pta/points_to.h"

#include <iostream>
#include <sstream>
#include <string>

using namespace pta;

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      ++failures;                                                \
      std::cerr << "FAIL " << __LINE__ << ": " #cond "\n";       \
    }                                                            \
  } while (0)

static std::string show(const Analysis::ObjSet& s) {
  std::ostringstream os;
  os << "{";
  bool first = true;
  for (const Obj& o : s) {
    if (!first) os << ", ";
    os << "obj@" << o.site;
    first = false;
  }
  os << "}";
  return os.str();
}

static void dump(Analysis& a, const char* title) {
  std::cout << "--- " << title << " ---\n";
  for (const auto& [v, pts] : a.var_points_to())
    std::cout << "pts(" << v << ") = " << show(pts) << "\n";
  for (const auto& [o, fields] : a.field_points_to())
    for (const auto& [f, pts] : fields)
      std::cout << "fld(obj@" << o.site << ", " << f << ") = " << show(pts)
                << "\n";
}

// Alloc + copy: inclusion constraints propagate, result is minimal (exact).
static void test_basic() {
  Analysis a;
  a.add(alloc("x", 1));
  a.add(alloc("y", 2));
  a.add(copy("p", "x"));
  a.add(copy("q", "p"));
  a.add(copy("q", "y"));
  dump(a, "basic");
  CHECK(a.points_to("p") == Analysis::ObjSet{Obj{1}});
  CHECK(a.points_to("q") == (Analysis::ObjSet{Obj{1}, Obj{2}}));
  CHECK(a.points_to("x") == Analysis::ObjSet{Obj{1}});
  CHECK(a.points_to("z").empty());  // unknown var -> empty
  // Minimality: no extra variables or objects appear.
  CHECK(a.var_points_to().size() == 4);
}

// Store/load through object fields.
static void test_fields() {
  Analysis a;
  a.add(alloc("x", 10));
  a.add(alloc("y", 11));
  a.add(alloc("p", 20));
  a.add(store("p", "f", "x"));   // p->f = x
  a.add(store("p", "g", "y"));   // p->g = y
  a.add(load("v", "p", "f"));    // v = p->f
  a.add(load("w", "p", "g"));    // w = p->g
  dump(a, "fields");
  CHECK(a.points_to("v") == Analysis::ObjSet{Obj{10}});
  CHECK(a.points_to("w") == Analysis::ObjSet{Obj{11}});
  CHECK(a.field_points_to().at(Obj{20}).at("f") ==
        Analysis::ObjSet{Obj{10}});
  CHECK(a.field_points_to().at(Obj{20}).at("g") ==
        Analysis::ObjSet{Obj{11}});
}

// Cyclic structure + loop-carried load: iteration must reach a fixpoint.
static void test_fixpoint() {
  Analysis a;
  a.add(alloc("n0", 1));
  a.add(alloc("n1", 2));
  a.add(store("n0", "next", "n1"));  // n0->next = n1
  a.add(store("n1", "next", "n0"));  // n1->next = n0 (cycle)
  a.add(copy("cur", "n0"));
  a.add(load("cur", "cur", "next"));  // loop body: cur = cur->next
  dump(a, "fixpoint");
  CHECK(a.points_to("cur") == (Analysis::ObjSet{Obj{1}, Obj{2}}));
  CHECK(a.field_points_to().at(Obj{1}).at("next") ==
        Analysis::ObjSet{Obj{2}});
  CHECK(a.field_points_to().at(Obj{2}).at("next") ==
        Analysis::ObjSet{Obj{1}});
}

// Deleting statements must not leave unsupported aliases behind; the result
// must equal a from-empty recomputation over the remaining statements.
static void test_deletion() {
  Analysis a;
  a.add(alloc("a", 1));
  a.add(alloc("b", 2));
  a.add(copy("p", "a"));
  std::size_t id_pb = a.add(copy("p", "b"));  // to be deleted
  a.add(copy("q", "p"));
  a.add(alloc("x", 10));
  a.add(alloc("y", 11));
  a.add(alloc("r", 20));
  a.add(store("r", "f", "x"));
  std::size_t id_rf_y = a.add(store("r", "f", "y"));  // to be deleted
  a.add(load("v", "r", "f"));

  dump(a, "before deletion");
  CHECK(a.points_to("q") == (Analysis::ObjSet{Obj{1}, Obj{2}}));
  CHECK(a.points_to("v") == (Analysis::ObjSet{Obj{10}, Obj{11}}));

  CHECK(a.remove(id_pb));
  CHECK(a.remove(id_rf_y));
  CHECK(!a.remove(id_pb));  // double removal rejected

  dump(a, "after deletion");
  // No unsupported aliases: b's and y's objects must be gone downstream.
  CHECK(a.points_to("p") == Analysis::ObjSet{Obj{1}});
  CHECK(a.points_to("q") == Analysis::ObjSet{Obj{1}});
  CHECK(a.points_to("v") == Analysis::ObjSet{Obj{10}});
  CHECK(a.field_points_to().at(Obj{20}).at("f") ==
        Analysis::ObjSet{Obj{10}});

  // Compare against recomputation from empty over the live statements.
  Analysis fresh = analyze(a.statements());
  CHECK(a.var_points_to() == fresh.var_points_to());
  CHECK(a.field_points_to() == fresh.field_points_to());
  if (a.var_points_to() == fresh.var_points_to() &&
      a.field_points_to() == fresh.field_points_to())
    std::cout << "deletion result == from-empty recomputation\n";
}

int main(int argc, char** argv) {
  std::string which = argc > 1 ? argv[1] : "all";
  if (which == "basic") test_basic();
  else if (which == "fields") test_fields();
  else if (which == "fixpoint") test_fixpoint();
  else if (which == "deletion") test_deletion();
  else {
    std::cerr << "unknown test: " << which << "\n";
    return 2;
  }
  if (failures == 0) std::cout << which << ": PASS\n";
  return failures == 0 ? 0 : 1;
}
