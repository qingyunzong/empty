#pragma once

#include <exception>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace dlks_test {

struct Case {
  const char* name;
  void (*fn)();
};

inline std::vector<Case>& registry() {
  static std::vector<Case> cases;
  return cases;
}

struct Registrar {
  Registrar(const char* name, void (*fn)()) { registry().push_back({name, fn}); }
};

class Failure : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

[[noreturn]] inline void fail(const char* file, int line,
                              const std::string& message) {
  std::ostringstream out;
  out << file << ':' << line << ": " << message;
  throw Failure(out.str());
}

template <class A, class B>
void check_eq(const A& actual, const B& expected, const char* actual_expr,
              const char* expected_expr, const char* file, int line) {
  if (!(actual == expected)) {
    std::ostringstream out;
    out << actual_expr << " == " << expected_expr << " (actual " << actual
        << ", expected " << expected << ')';
    fail(file, line, out.str());
  }
}

template <class A, class B>
void check_ne(const A& actual, const B& unexpected, const char* actual_expr,
              const char* unexpected_expr, const char* file, int line) {
  if (actual == unexpected) {
    std::ostringstream out;
    out << actual_expr << " != " << unexpected_expr << " (both " << actual
        << ')';
    fail(file, line, out.str());
  }
}

inline void check_true(bool value, const char* expr, const char* file,
                       int line) {
  if (!value) {
    fail(file, line, std::string("expected true: ") + expr);
  }
}

}  // namespace dlks_test

#define DLKS_TEST(name)                                           \
  static void name();                                             \
  static ::dlks_test::Registrar dlks_reg_##name(#name, name);     \
  static void name()

#define CHECK(expr) \
  ::dlks_test::check_true((expr), #expr, __FILE__, __LINE__)

#define CHECK_EQ(actual, expected)                                    \
  ::dlks_test::check_eq((actual), (expected), #actual, #expected,     \
                        __FILE__, __LINE__)

#define CHECK_NE(actual, unexpected)                                  \
  ::dlks_test::check_ne((actual), (unexpected), #actual, #unexpected, \
                        __FILE__, __LINE__)
