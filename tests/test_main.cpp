#include "test_framework.hpp"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace testfw {

Options& options() {
  static Options value;
  return value;
}

std::vector<TestCase>& tests() {
  static std::vector<TestCase> value;
  return value;
}

Registrar::Registrar(std::string name, std::function<void()> fn) {
  tests().push_back(TestCase{std::move(name), std::move(fn)});
}

}  // namespace testfw

namespace {

std::uint64_t parse_unsigned(const std::string& flag, const std::string& text) {
  try {
    std::size_t consumed = 0;
    const unsigned long long value = std::stoull(text, &consumed);
    if (consumed != text.size()) {
      throw std::invalid_argument("trailing characters");
    }
    return value;
  } catch (const std::exception&) {
    std::cerr << "invalid value for " << flag << ": '" << text << "'\n";
    std::exit(2);
  }
}

}  // namespace

int main(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) {
    const std::string argument = argv[i];
    if (argument.rfind("--seeds=", 0) == 0) {
      testfw::options().differential_seeds =
          static_cast<std::size_t>(parse_unsigned("--seeds", argument.substr(8)));
    } else if (argument.rfind("--seed-base=", 0) == 0) {
      testfw::options().seed_base = parse_unsigned("--seed-base", argument.substr(12));
    } else if (argument.rfind("--filter=", 0) == 0) {
      testfw::options().filter = argument.substr(9);
    } else if (argument == "--list") {
      for (const auto& test : testfw::tests()) {
        std::cout << test.name << "\n";
      }
      return 0;
    } else {
      std::cerr << "unknown argument: " << argument << "\n";
      return 2;
    }
  }

  std::size_t passed = 0;
  std::size_t failed = 0;
  std::size_t skipped = 0;
  for (const auto& test : testfw::tests()) {
    if (!testfw::options().filter.empty() &&
        test.name.find(testfw::options().filter) == std::string::npos) {
      ++skipped;
      continue;
    }
    try {
      test.fn();
      ++passed;
      std::cout << "PASS " << test.name << "\n";
    } catch (const std::exception& error) {
      ++failed;
      std::cout << "FAIL " << test.name << "\n  " << error.what() << "\n";
    }
  }

  std::cout << "\n" << passed << " passed, " << failed << " failed, " << skipped << " skipped\n";
  return failed == 0 ? 0 : 1;
}
