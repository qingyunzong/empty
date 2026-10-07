// geom_tool: interactive geometry tool.
//
// Reads whitespace-separated commands from stdin, one per line:
//   add <id> <x1> <y1> <x2> <y2>   add or replace a rectangle by id
//   remove <id>                    remove a rectangle by id
//   area                           print exact union area
//   perimeter                      print exact union perimeter
//   count                          print number of stored rectangles
// Lines starting with '#' and blank lines are ignored.

#include "geom/rect_union.hpp"

#include <cstdint>
#include <iostream>
#include <string>

int main() {
    geom::RectUnion ru;
    std::string cmd;
    bool ok = true;

    while (std::cin >> cmd) {
        if (cmd == "add") {
            geom::RectUnion::Id id;
            geom::RectUnion::Coord x1, y1, x2, y2;
            if (!(std::cin >> id >> x1 >> y1 >> x2 >> y2)) {
                std::cerr << "error: malformed 'add' command\n";
                ok = false;
                break;
            }
            ru.add(id, x1, y1, x2, y2);
        } else if (cmd == "remove") {
            geom::RectUnion::Id id;
            if (!(std::cin >> id)) {
                std::cerr << "error: malformed 'remove' command\n";
                ok = false;
                break;
            }
            ru.remove(id);
        } else if (cmd == "area") {
            std::cout << ru.area() << '\n';
        } else if (cmd == "perimeter") {
            std::cout << ru.perimeter() << '\n';
        } else if (cmd == "count") {
            std::cout << ru.size() << '\n';
        } else if (!cmd.empty() && cmd[0] == '#') {
            std::string rest;
            std::getline(std::cin, rest);
        } else {
            std::cerr << "error: unknown command '" << cmd << "'\n";
            ok = false;
            break;
        }
    }

    return ok ? 0 : 1;
}
