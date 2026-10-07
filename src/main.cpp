#include "counter_set.hpp"

#include <iostream>
#include <string>

// Simple CLI:
//   first line: N            (tracks integers 0..N)
//   then commands, one per line:
//     add <lo> <hi> <delta>  range update; prints REJECTED if it would go negative
//     query                  prints the minimum missing value, or FULL
int main() {
    std::size_t n = 0;
    if (!(std::cin >> n)) {
        std::cerr << "usage: provide N on the first line\n";
        return 1;
    }
    CounterSet cs(n);
    std::string cmd;
    while (std::cin >> cmd) {
        if (cmd == "add") {
            std::size_t lo, hi;
            long long delta;
            std::cin >> lo >> hi >> delta;
            try {
                if (!cs.add(lo, hi, delta)) std::cout << "REJECTED\n";
            } catch (const std::out_of_range&) {
                std::cout << "BAD_RANGE\n";
            }
        } else if (cmd == "query") {
            auto missing = cs.firstZero();
            if (missing) {
                std::cout << *missing << "\n";
            } else {
                std::cout << "FULL\n";
            }
        } else {
            std::cerr << "unknown command: " << cmd << "\n";
            return 1;
        }
    }
    return 0;
}
