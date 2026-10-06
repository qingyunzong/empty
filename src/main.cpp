#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "score.hpp"

namespace {

void usage(const char* prog) {
    std::cerr <<
        "usage: " << prog << " [score-file]\n"
        "  Reads a score (stdin when no file or '-' is given) and prints one\n"
        "  line per event: <pitch|r> <start-beat> <end-beat>\n"
        "\n"
        "score syntax:\n"
        "  note   : <pitch>/<denom>[. ...]   e.g. c4/4  f#3/8.  (whole = 4 beats)\n"
        "  rest   : r/<denom>[. ...]         e.g. r/8\n"
        "  tuplet : { <items> } = <beats>    e.g. { c4/8 d4/8 e4/8 } = 1\n"
        "  beats may be an integer or a fraction (e.g. 3/2); tuplets nest up to "
        << score::kMaxTupletDepth << " levels.\n"
        "  '#' at token start begins a comment; ',' and '|' are ignored.\n";
}

} // namespace

int main(int argc, char** argv) {
    std::string text;
    if (argc > 2 || (argc == 2 && (std::string(argv[1]) == "-h" ||
                                   std::string(argv[1]) == "--help"))) {
        usage(argv[0]);
        return argc > 2 ? 1 : 0;
    }
    if (argc == 2 && std::string(argv[1]) != "-") {
        std::ifstream in(argv[1]);
        if (!in) {
            std::cerr << "error: cannot open '" << argv[1] << "'\n";
            return 1;
        }
        std::ostringstream ss;
        ss << in.rdbuf();
        text = ss.str();
    } else {
        std::ostringstream ss;
        ss << std::cin.rdbuf();
        text = ss.str();
    }

    try {
        for (const score::Event& ev : score::expand_score(text)) {
            std::cout << ev.pitch << ' ' << ev.start.str() << ' ' << ev.end.str()
                      << '\n';
        }
    } catch (const score::ParseError& e) {
        std::cerr << e.what() << '\n';
        return 1;
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << '\n';
        return 1;
    }
    return 0;
}
