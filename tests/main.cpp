#include "test_framework.hpp"

#include <iostream>

int main() {
  int failed = 0;
  const auto& cases = dlks_test::registry();
  for (const auto& test : cases) {
    try {
      test.fn();
      std::cout << "[PASS] " << test.name << '\n';
    } catch (const std::exception& error) {
      ++failed;
      std::cout << "[FAIL] " << test.name << "\n       " << error.what()
                << '\n';
    }
  }
  std::cout << "\n" << cases.size() - failed << '/' << cases.size()
            << " tests passed\n";
  return failed == 0 ? 0 : 1;
}
