#pragma once

// Minimal test harness (standard library only).

#include <cstdio>
#include <string>

namespace testutil {

inline int& checkCount() { static int n = 0; return n; }
inline int& failCount() { static int n = 0; return n; }

inline void report(bool ok, const char* expr, const char* file, int line,
                   const std::string& extra = "") {
  ++checkCount();
  if (!ok) {
    ++failCount();
    std::fprintf(stderr, "FAIL %s:%d: %s %s\n", file, line, expr,
                 extra.c_str());
  }
}

inline int summary(const char* name) {
  std::fprintf(stderr, "[%s] %d checks, %d failed\n", name, checkCount(),
               failCount());
  return failCount() == 0 ? 0 : 1;
}

} // namespace testutil

#define CHECK(cond) ::testutil::report(static_cast<bool>(cond), #cond, __FILE__, __LINE__)
#define CHECK_MSG(cond, msg) \
  ::testutil::report(static_cast<bool>(cond), #cond, __FILE__, __LINE__, (msg))
