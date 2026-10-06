#include "geom/rect_union.h"

#include <cstdint>
#include <iostream>
#include <string>

// Simple stdin-driven CLI:
//   add <id> <x1> <y1> <x2> <y2>   -> OK | IGNORED (zero area) | EXISTS
//   remove <id>                    -> OK | NOT_FOUND
//   query                          -> "<area> <perimeter>"
//   count                          -> number of stored rectangles
//   quit                           -> exit
int main() {
    geom::RectUnion ru;
    std::string cmd;
    while (std::cin >> cmd) {
        if (cmd == "add") {
            std::int64_t id, x1, y1, x2, y2;
            if (!(std::cin >> id >> x1 >> y1 >> x2 >> y2)) {
                std::cerr << "malformed add\n";
                return 1;
            }
            if (x1 == x2 || y1 == y2) {
                std::cout << "IGNORED\n";
            } else if (ru.contains(id)) {
                std::cout << "EXISTS\n";
            } else {
                ru.add(id, x1, y1, x2, y2);
                std::cout << "OK\n";
            }
        } else if (cmd == "remove") {
            std::int64_t id;
            if (!(std::cin >> id)) {
                std::cerr << "malformed remove\n";
                return 1;
            }
            std::cout << (ru.remove(id) ? "OK" : "NOT_FOUND") << '\n';
        } else if (cmd == "query") {
            std::cout << ru.area() << ' ' << ru.perimeter() << '\n';
        } else if (cmd == "count") {
            std::cout << ru.size() << '\n';
        } else if (cmd == "quit") {
            break;
        } else {
            std::cerr << "unknown command: " << cmd << '\n';
            return 1;
        }
    }
    return 0;
}
