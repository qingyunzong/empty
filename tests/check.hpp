#pragma once

#include <cstdio>

namespace tst {
inline int& checks() { static int c = 0; return c; }
inline int& failures() { static int f = 0; return f; }
inline int summary(const char* name) {
  std::printf("%s: %d checks, %d failures\n", name, checks(), failures());
  return failures() == 0 ? 0 : 1;
}
} // namespace tst

#define CHECK(cond)                                                        \
  do {                                                                     \
    ++tst::checks();                                                       \
    if (!(cond)) {                                                         \
      ++tst::failures();                                                   \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
    }                                                                      \
  } while (0)
