#pragma once

#include <cstdio>

namespace check {

inline int failures = 0;

inline void report(const char* file, int line, const char* expr) {
  std::fprintf(stderr, "FAIL %s:%d: %s\n", file, line, expr);
  ++failures;
}

inline int summary(const char* name) {
  if (failures) {
    std::fprintf(stderr, "%s: %d failure(s)\n", name, failures);
    return 1;
  }
  std::printf("%s: ok\n", name);
  return 0;
}

} // namespace check

#define CHECK(cond)                                    \
  do {                                                 \
    if (!(cond))                                       \
      ::check::report(__FILE__, __LINE__, #cond);      \
  } while (0)
