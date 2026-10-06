#pragma once

#include <cstdio>
#include <cstdlib>

namespace testing {

inline int& failures() {
  static int count = 0;
  return count;
}

inline int finish() {
  if (failures() == 0) {
    std::printf("ALL CHECKS PASSED\n");
    return 0;
  }
  std::printf("%d CHECK(S) FAILED\n", failures());
  return 1;
}

} // namespace testing

#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "CHECK failed %s:%d: %s\n", __FILE__, __LINE__, \
                   #cond);                                                 \
      ++::testing::failures();                                             \
    }                                                                      \
  } while (0)

#define CHECK_EQ(a, b)                                                     \
  do {                                                                     \
    auto va = (a);                                                         \
    auto vb = (b);                                                         \
    if (!(va == vb)) {                                                     \
      std::fprintf(stderr,                                                 \
                   "CHECK_EQ failed %s:%d: %s != %s (%llu vs %llu)\n",     \
                   __FILE__, __LINE__, #a, #b, (unsigned long long)(va),   \
                   (unsigned long long)(vb));                              \
      ++::testing::failures();                                             \
    }                                                                      \
  } while (0)
