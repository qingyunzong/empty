#pragma once

#include <iostream>

namespace intmesh::test {

inline int& failureCount() {
  static int count = 0;
  return count;
}

inline int summarize(const char* testName) {
  if (failureCount() == 0) {
    std::cout << testName << ": all checks passed\n";
    return 0;
  }
  std::cerr << testName << ": " << failureCount() << " check(s) FAILED\n";
  return 1;
}

}  // namespace intmesh::test

#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      ++::intmesh::test::failureCount();                                \
      std::cerr << __FILE__ << ":" << __LINE__ << " CHECK failed: "     \
                << #cond << "\n";                                       \
    }                                                                   \
  } while (0)

#define CHECK_EQ(a, b)                                                  \
  do {                                                                  \
    if (!((a) == (b))) {                                                \
      ++::intmesh::test::failureCount();                                \
      std::cerr << __FILE__ << ":" << __LINE__ << " CHECK_EQ failed: "  \
                << #a " == " #b << "\n";                                \
    }                                                                   \
  } while (0)
