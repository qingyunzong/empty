#include "score/parser.hpp"

#include <iostream>
#include <sstream>

namespace {

void printUsage(const char* prog) {
    std::cerr << "usage: " << prog << " [score...]\n"
              << "  reads the score from arguments, or stdin when no arguments are given\n"
              << "  syntax: NOTE = (A-G)[#|b][octave] | R (rest)\n"
              << "          duration: /n with optional dots, e.g. /4 /8. /2..\n"
              << "          tuplet:   {beats: item...} scales the group to <beats> beats\n"
              << "  output: one line per event: <pitch|R> <start> <end> (beats)\n";
}

} // namespace

int main(int argc, char** argv) {
    std::string input;
    if (argc > 1) {
        std::string arg = argv[1];
        if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        }
        for (int i = 1; i < argc; ++i) {
            if (i > 1) input += ' ';
            input += argv[i];
        }
    } else {
        std::ostringstream ss;
        ss << std::cin.rdbuf();
        input = ss.str();
    }

    try {
        for (const auto& e : score::parseScore(input)) {
            std::cout << (e.isRest ? "R" : e.pitch) << ' '
                      << score::formatRational(e.start) << ' '
                      << score::formatRational(e.end) << '\n';
        }
    } catch (const std::exception& ex) {
        std::cerr << "error: " << ex.what() << '\n';
        return 1;
    }
    return 0;
}
