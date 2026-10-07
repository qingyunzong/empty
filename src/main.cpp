#include <iostream>
#include <string>

#include "mex_counter.hpp"

// Input:
//   N Q
//   then Q operations, one per line:
//     add l r v   -- add v (may be negative) to counts of l..r
//     mex         -- query smallest zero-count value
// Output per operation:
//   add -> "OK" or "REJECT" (update refused, nothing changed)
//   mex -> the value, or "FULL" when every count in 0..N is positive
int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    std::size_t n;
    std::size_t q;
    if (!(std::cin >> n >> q)) {
        return 0;
    }
    MexCounter counter(n);
    for (std::size_t i = 0; i < q; ++i) {
        std::string op;
        std::cin >> op;
        if (op == "add") {
            std::size_t l, r;
            long long v;
            std::cin >> l >> r >> v;
            std::cout << (counter.add(l, r, v) ? "OK" : "REJECT") << '\n';
        } else if (op == "mex") {
            auto m = counter.first_zero();
            if (m) {
                std::cout << *m << '\n';
            } else {
                std::cout << "FULL\n";
            }
        }
    }
    return 0;
}
