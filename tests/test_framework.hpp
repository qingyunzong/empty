#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <ostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

template <typename T>
std::ostream& operator<<(std::ostream& os, const std::vector<T>& values) {
  os << "[";
  for (std::size_t i = 0; i < values.size(); ++i) {
    if (i != 0) {
      os << ", ";
    }
    os << values[i];
  }
  os << "]";
  return os;
}

namespace testfw {

struct Options {
  std::string filter;
  std::size_t differential_seeds = 300;
  std::uint64_t seed_base = 0x5EED5EEDULL;
};

Options& options();

struct TestCase {
  std::string name;
  std::function<void()> fn;
};

std::vector<TestCase>& tests();

struct Registrar {
  Registrar(std::string name, std::function<void()> fn);
};

[[noreturn]] inline void fail(const char* file, int line, const std::string& message) {
  std::ostringstream out;
  out << file << ":" << line << ": " << message;
  throw std::runtime_error(out.str());
}

inline void check(bool condition, const char* expression, const char* file, int line) {
  if (!condition) {
    fail(file, line, std::string("CHECK failed: ") + expression);
  }
}

template <typename Lhs, typename Rhs>
void check_eq(const Lhs& lhs, const Rhs& rhs, const char* lhs_expression,
              const char* rhs_expression, const char* file, int line) {
  if (!(lhs == rhs)) {
    std::ostringstream out;
    out << "CHECK_EQ failed: " << lhs_expression << " == " << rhs_expression << "\n  lhs: "
        << lhs << "\n  rhs: " << rhs;
    fail(file, line, out.str());
  }
}

}  // namespace testfw

#define TEST(name)                                            \
  static void name();                                         \
  static ::testfw::Registrar registrar_##name(#name, name);   \
  static void name()

#define CHECK(condition) ::testfw::check((condition), #condition, __FILE__, __LINE__)

#define CHECK_EQ(lhs, rhs) \
  ::testfw::check_eq((lhs), (rhs), #lhs, #rhs, __FILE__, __LINE__)

#define CHECK_THROWS_AS(expression, exception_type)                                  \
  do {                                                                               \
    bool caught = false;                                                             \
    try {                                                                            \
      (void)(expression);                                                            \
    } catch (const exception_type&) {                                                \
      caught = true;                                                                 \
    } catch (const std::exception& other) {                                          \
      ::testfw::fail(__FILE__, __LINE__,                                             \
                     std::string("wrong exception from " #expression ": ") +        \
                         other.what());                                              \
    } catch (...) {                                                                  \
      ::testfw::fail(__FILE__, __LINE__,                                             \
                     "wrong non-standard exception from " #expression);             \
    }                                                                                \
    if (!caught) {                                                                   \
      ::testfw::fail(__FILE__, __LINE__,                                             \
                     "expected " #exception_type " from " #expression);             \
    }                                                                                \
  } while (false)
