#pragma once

#include "ser/serializer.hpp"

#include <cstdio>
#include <cstdlib>

#define REQUIRE(cond)                                                        \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::fprintf(stderr, "REQUIRE failed at %s:%d: %s\n", __FILE__,        \
                   __LINE__, #cond);                                         \
      std::abort();                                                          \
    }                                                                        \
  } while (0)

struct Node : ser::Serializable {
  static inline int live_count = 0;
  std::int64_t value = 0;
  std::string name;
  Node* left = nullptr;
  Node* right = nullptr;

  Node() { ++live_count; }
  ~Node() override { --live_count; }

  void write_fields(ser::FieldWriter& w) const override {
    w.field_int(value);
    w.field_str(name);
    w.field_ref(left);
    w.field_ref(right);
  }
  void read_fields(ser::FieldReader& r) override {
    value = r.read_int();
    name = r.read_str();
    r.read_ref(left);
    r.read_ref(right);
  }
};

struct Leaf : ser::Serializable {
  static inline int live_count = 0;
  std::int64_t tag = 0;

  Leaf() { ++live_count; }
  ~Leaf() override { --live_count; }

  void write_fields(ser::FieldWriter& w) const override { w.field_int(tag); }
  void read_fields(ser::FieldReader& r) override { tag = r.read_int(); }
};

inline ser::Registry make_registry() {
  ser::Registry reg;
  reg.add<Node>("Node");
  reg.add<Leaf>("Leaf");
  return reg;
}
