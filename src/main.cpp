#include "analysis.hpp"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

using namespace cfg;

static std::string setStr(const std::set<int>& s) {
    std::string out = "{";
    bool first = true;
    for (int v : s) {
        if (!first) out += ' ';
        out += std::to_string(v);
        first = false;
    }
    return out + '}';
}

static std::string vecStr(const std::vector<int>& v) {
    std::string out = "{";
    bool first = true;
    for (int x : v) {
        if (!first) out += ' ';
        out += std::to_string(x);
        first = false;
    }
    return out + '}';
}

static void printLoopTree(const std::vector<NaturalLoop>& loops, int idx, int depth,
                          const std::string& prefix) {
    const auto& loop = loops[idx];
    std::cout << prefix << std::string(depth * 2, ' ') << "natural-loop header=" << loop.header
              << " latches=" << vecStr(loop.latches) << " body=" << setStr(loop.body) << '\n';
    for (int i = 0; i < (int)loops.size(); ++i)
        if (loops[i].parent == idx) printLoopTree(loops, i, depth + 1, prefix);
}

static void printAnalysis(const Graph& g, const std::string& prefix) {
    const auto mask = reachableMask(g);
    const auto dom = dominatorSets(g);
    int reach = 0;
    for (bool b : mask) reach += b ? 1 : 0;

    std::cout << prefix << "graph: nodes=" << g.size() << " edges=" << g.edgeCount()
              << " entry=" << g.entry << '\n';
    std::cout << prefix << "reachable: " << reach << "/" << g.size() << '\n';

    const auto bes = backEdges(g, dom);
    if (bes.empty())
        std::cout << prefix << "back-edge: none\n";
    else
        for (const auto& be : bes)
            std::cout << prefix << "back-edge: " << be.from << " -> " << be.to << '\n';

    const auto loops = naturalLoops(g, dom);
    if (loops.empty()) std::cout << prefix << "natural-loop: none\n";
    for (int i = 0; i < (int)loops.size(); ++i)
        if (loops[i].parent < 0) printLoopTree(loops, i, 0, prefix);

    const auto irr = irreducibleLoops(g, dom);
    if (irr.empty())
        std::cout << prefix << "irreducible-loop: none\n";
    else
        for (const auto& l : irr)
            std::cout << prefix << "irreducible-loop entries=" << setStr(l.entries)
                      << " nodes=" << setStr(l.nodes) << '\n';
}

static int usage() {
    std::cerr << "usage: loopfind [--split] <file|->\n"
                 "  input: lines of 'entry N' and 'edge U V' ('#' comments)\n"
                 "  --split: also analyze a node-split reducible copy (input unchanged)\n";
    return 2;
}

int main(int argc, char** argv) {
    bool split = false;
    std::string path;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--split")
            split = true;
        else if (a == "-h" || a == "--help")
            return usage();
        else if (path.empty())
            path = a;
        else
            return usage();
    }
    if (path.empty()) return usage();

    try {
        Graph g;
        if (path == "-") {
            g = loadGraph(std::cin);
        } else {
            std::ifstream in(path);
            if (!in) {
                std::cerr << "loopfind: cannot open '" << path << "'\n";
                return 1;
            }
            g = loadGraph(in);
        }
        printAnalysis(g, "");
        if (split) {
            const Graph before = g;
            const Graph s = splitCopy(g);
            printAnalysis(s, "split ");
            std::cout << "input-unchanged: " << (g == before ? "yes" : "no") << '\n';
        }
    } catch (const std::exception& e) {
        std::cerr << "loopfind: " << e.what() << '\n';
        return 1;
    }
    return 0;
}
