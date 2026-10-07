#include <fstream>
#include <iostream>
#include <istream>
#include <optional>
#include <string>

#include "model.hpp"

namespace {

void printUsage(const char* prog) {
    std::cerr << "usage: " << prog << " [--all] <logfile|-\n"
              << "\n"
              << "log format (one event per line, '#' starts a comment):\n"
              << "  <thread> wait    <lock> <shared|exclusive>\n"
              << "  <thread> acquire <lock> <shared|exclusive>\n"
              << "  <thread> release <lock>\n"
              << "\n"
              "exit status: 0 = no deadlock, 1 = deadlock found, 2 = usage/parse error\n";
}

void printCycle(const dl::Engine& engine, const dl::Cycle& cycle,
                std::size_t eventIndex) {
    const dl::Event& at = engine.events()[eventIndex];
    std::cout << "Deadlock detected at event #" << (eventIndex + 1) << " (line "
              << at.line << ": " << at.raw << ")\n";
    std::cout << "Shortest wait-for cycle (" << cycle.nodes.size() << " thread"
              << (cycle.nodes.size() == 1 ? "" : "s") << "):\n";
    const auto& names = engine.threadNames();
    for (std::size_t i = 0; i < cycle.nodes.size(); ++i) {
        const std::size_t next = (i + 1) % cycle.nodes.size();
        std::cout << "  " << names[cycle.nodes[i]] << " -> " << names[cycle.nodes[next]]
                  << "\n";
        for (const auto& label : cycle.edges[i].labels) {
            const dl::Event& wait = engine.events()[label.waitEvent];
            const dl::Event& hold = engine.events()[label.holderEvent];
            std::cout << "    lock " << label.lock << " (" << dl::toString(wait.mode)
                      << " wait vs " << dl::toString(hold.mode) << " hold)\n"
                      << "    wait event:   line " << wait.line << ": " << wait.raw << "\n"
                      << "    holder event: line " << hold.line << ": " << hold.raw << "\n";
        }
    }
}

}  // namespace

int main(int argc, char** argv) {
    bool all = false;
    std::string path;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--all") {
            all = true;
        } else if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        } else if (path.empty()) {
            path = arg;
        } else {
            printUsage(argv[0]);
            return 2;
        }
    }
    if (path.empty()) {
        printUsage(argv[0]);
        return 2;
    }

    std::ifstream file;
    std::istream* in = &std::cin;
    if (path != "-") {
        file.open(path);
        if (!file) {
            std::cerr << "error: cannot open '" << path << "'\n";
            return 2;
        }
        in = &file;
    }

    dl::Engine engine;
    bool anyDeadlock = false;
    std::size_t deadlockedMoments = 0;
    std::optional<dl::Cycle> firstCycle;
    std::size_t firstEvent = 0;

    std::string line;
    std::size_t lineNo = 0;
    while (std::getline(*in, line)) {
        ++lineNo;
        const dl::ParseResult parsed = dl::parseLine(line, lineNo);
        if (!parsed.error.empty()) {
            std::cerr << "parse error at line " << lineNo << ": " << parsed.error << "\n";
            return 2;
        }
        if (!parsed.isEvent) {
            continue;
        }
        const std::size_t eventIndex = engine.events().size();
        std::optional<dl::Cycle> cycle = engine.step(parsed.event);
        if (cycle) {
            ++deadlockedMoments;
            if (!anyDeadlock) {
                anyDeadlock = true;
                firstCycle = cycle;
                firstEvent = eventIndex;
            }
            if (all) {
                printCycle(engine, *cycle, eventIndex);
                std::cout << "\n";
            }
        }
    }

    if (!anyDeadlock) {
        std::cout << "No deadlock detected (" << engine.events().size()
                  << " events checked, full graph rebuilt at every moment).\n";
        return 0;
    }
    if (!all) {
        printCycle(engine, *firstCycle, firstEvent);
    }
    std::cout << "Deadlock present at " << deadlockedMoments << " of "
              << engine.events().size() << " moments.\n";
    return 1;
}
