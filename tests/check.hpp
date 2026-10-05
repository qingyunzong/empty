#pragma once

#include <iostream>

namespace testutil {

inline int& failures() {
  static int n = 0;
  return n;
}

inline int finish(const char* name) {
  if (failures() == 0) {
    std::cout << name << ": all checks passed\n";
    return 0;
  }
  std::cerr << name << ": " << failures() << " check(s) FAILED\n";
  return 1;
}

}  // namespace testutil

#define CHECK(cond)                                          \
  do {                                                       \
    if (!(cond)) {                                           \
      ++testutil::failures();                                \
      std::cerr << __FILE__ << ':' << __LINE__               \
                << " CHECK failed: " #cond "\n";             \
    }                                                        \
  } while (0)
