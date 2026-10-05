#pragma once

#include <functional>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

// Minimal test framework: register cases with TF_TEST, check with CHECK /
// CHECK_EQ, end the translation unit with TF_MAIN().
namespace tf {

struct Case {
    std::string name;
    std::function<void()> fn;
};

inline std::vector<Case>& cases() {
    static std::vector<Case> c;
    return c;
}

inline int& failure_count() {
    static int n = 0;
    return n;
}

struct Registrar {
    Registrar(std::string name, std::function<void()> fn) {
        cases().push_back({std::move(name), std::move(fn)});
    }
};

inline void report_failure(const char* file, int line, const std::string& expr) {
    ++failure_count();
    std::cerr << "  FAIL " << file << ":" << line << ": " << expr << "\n";
}

inline int run_all() {
    int failed_cases = 0;
    for (auto& c : cases()) {
        std::cout << "[ RUN  ] " << c.name << "\n";
        const int before = failure_count();
        c.fn();
        if (failure_count() == before) {
            std::cout << "[  OK  ] " << c.name << "\n";
        } else {
            ++failed_cases;
            std::cout << "[ FAIL ] " << c.name << "\n";
        }
    }
    std::cout << (failed_cases == 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED") << " ("
              << cases().size() << " cases)\n";
    return failed_cases == 0 ? 0 : 1;
}

}  // namespace tf

#define TF_TEST(name)                                          \
    static void name();                                        \
    static ::tf::Registrar registrar_##name(#name, name);      \
    static void name()

#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) ::tf::report_failure(__FILE__, __LINE__, "CHECK(" #cond ")"); \
    } while (0)

#define CHECK_EQ(a, b)                                                             \
    do {                                                                           \
        auto&& va = (a);                                                           \
        auto&& vb = (b);                                                           \
        if (!(va == vb))                                                           \
            ::tf::report_failure(__FILE__, __LINE__, "CHECK_EQ(" #a ", " #b ")");  \
    } while (0)

#define TF_MAIN() int main() { return ::tf::run_all(); }
