#pragma once

#include <cstdint>
#include <cstdio>
#include <functional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace tf {

struct Case {
  std::string name;
  std::function<void()> fn;
};

inline std::vector<Case>& cases() {
  static std::vector<Case> c;
  return c;
}

struct Reg {
  Reg(std::string name, std::function<void()> fn) {
    cases().push_back({std::move(name), std::move(fn)});
  }
};

inline int run() {
  int failed = 0;
  for (auto& c : cases()) {
    try {
      c.fn();
      std::printf("PASS %s\n", c.name.c_str());
    } catch (const std::exception& e) {
      ++failed;
      std::printf("FAIL %s: %s\n", c.name.c_str(), e.what());
    } catch (...) {
      ++failed;
      std::printf("FAIL %s: unknown exception\n", c.name.c_str());
    }
  }
  std::printf("%s (%zu cases)\n", failed ? "FAILED" : "OK", cases().size());
  return failed ? 1 : 0;
}

} // namespace tf

#define TEST(name) \
  static void name(); \
  static tf::Reg reg_##name(#name, name); \
  static void name()

#define CHECK(cond) \
  do { \
    if (!(cond)) \
      throw std::runtime_error(std::string("CHECK failed: ") + #cond + \
                               " at " __FILE__ ":" + std::to_string(__LINE__)); \
  } while (0)

template <typename T>
auto printable(const T& v) {
  if constexpr (std::is_enum_v<T>)
    return static_cast<long long>(v);
  else if constexpr (std::is_same_v<T, bool> || std::is_same_v<T, uint8_t> ||
                     std::is_same_v<T, int8_t> || std::is_same_v<T, char>)
    return static_cast<int>(v);
  else
    return v;
}

template <typename A, typename B>
void checkEq(const A& a, const B& b, const char* sa, const char* sb, int line) {
  if (!std::cmp_equal(printable(a), printable(b))) {
    std::ostringstream os;
    os << "CHECK_EQ failed at line " << line << ": " << sa << " == " << sb
       << " (" << printable(a) << " vs " << printable(b) << ")";
    throw std::runtime_error(os.str());
  }
}

#define CHECK_EQ(a, b) checkEq((a), (b), #a, #b, __LINE__)

#define CHECK_THROWS_AS(expr, ExType) \
  do { \
    bool caught = false; \
    try { \
      (void)(expr); \
    } catch (const ExType&) { \
      caught = true; \
    } \
    if (!caught) \
      throw std::runtime_error(std::string("expected exception ") + #ExType + \
                               " from " + #expr + " at " __FILE__ ":" + \
                               std::to_string(__LINE__)); \
  } while (0)

#define CHECK_NOTHROW(expr) \
  do { \
    try { \
      (void)(expr); \
    } catch (const std::exception& e) { \
      throw std::runtime_error(std::string("unexpected exception from ") + \
                               #expr + ": " + e.what()); \
    } \
  } while (0)
