// inspector-cli: minimum-cost closed inspection walk on a small directed graph.
//
// Input (stdin or file given as argv[1]), '#' starts a comment:
//   n m s            -- vertices (1..10), edges, start vertex
//   u v w            -- m directed edges with non-negative cost w (edge id = line order, 0-based)
//   k                -- number of required edges
//   r1 r2 ... rk     -- required edge ids
//
// Output:
//   status: ok | unreachable
//   cost: <minimum total cost>
//   edges: <edge id sequence of the walk>
//   coverage: one line per required edge with its traversal count

#include "inspector.hpp"

#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

[[noreturn]] void usageError(const std::string& msg) {
  std::cerr << "input error: " << msg << "\n";
  std::cerr << "usage: inspector-cli [input-file]  (reads stdin if no file)\n";
  std::exit(2);
}

struct TokenStream {
  std::vector<std::string> tokens;
  size_t pos = 0;

  std::string next() {
    if (pos >= tokens.size())
      usageError("unexpected end of input");
    return tokens[pos++];
  }
  long long nextInt() {
    const std::string tok = next();
    size_t used = 0;
    long long value = 0;
    try {
      value = std::stoll(tok, &used);
    } catch (...) {
      usageError("expected integer, got '" + tok + "'");
    }
    if (used != tok.size())
      usageError("expected integer, got '" + tok + "'");
    return value;
  }
};

TokenStream tokenize(std::istream& in) {
  TokenStream ts;
  std::string line;
  while (std::getline(in, line)) {
    const size_t hash = line.find('#');
    if (hash != std::string::npos)
      line.resize(hash);
    std::istringstream ls(line);
    std::string tok;
    while (ls >> tok)
      ts.tokens.push_back(tok);
  }
  return ts;
}

inspect::Problem parse(std::istream& in) {
  TokenStream ts = tokenize(in);
  inspect::Problem p;
  p.n = static_cast<int>(ts.nextInt());
  const int m = static_cast<int>(ts.nextInt());
  p.start = static_cast<int>(ts.nextInt());
  if (p.n < 1 || p.n > 10)
    usageError("n must be in [1, 10]");
  if (m < 0)
    usageError("m must be non-negative");
  if (p.start < 0 || p.start >= p.n)
    usageError("start vertex out of range");
  for (int i = 0; i < m; ++i) {
    inspect::Edge e;
    e.u = static_cast<int>(ts.nextInt());
    e.v = static_cast<int>(ts.nextInt());
    e.w = ts.nextInt();
    if (e.u < 0 || e.u >= p.n || e.v < 0 || e.v >= p.n)
      usageError("edge " + std::to_string(i) + ": vertex out of range");
    if (e.w < 0)
      usageError("edge " + std::to_string(i) + ": negative cost");
    p.edges.push_back(e);
  }
  const int k = static_cast<int>(ts.nextInt());
  if (k < 0 || k > inspect::kMaxRequired)
    usageError("number of required edges must be in [0, " +
               std::to_string(inspect::kMaxRequired) + "]");
  for (int i = 0; i < k; ++i) {
    const int id = static_cast<int>(ts.nextInt());
    if (id < 0 || id >= m)
      usageError("required edge id " + std::to_string(id) + " out of range");
    p.required.push_back(id);
  }
  return p;
}

} // namespace

int main(int argc, char** argv) {
  inspect::Problem p;
  if (argc > 2)
    usageError("too many arguments");
  if (argc == 2) {
    std::ifstream file(argv[1]);
    if (!file)
      usageError(std::string("cannot open file: ") + argv[1]);
    p = parse(file);
  } else {
    p = parse(std::cin);
  }

  const inspect::Solution sol = inspect::solve(p);
  if (!sol.feasible) {
    std::cout << "status: unreachable\n";
    for (const auto& r : sol.infeasible) {
      const inspect::Edge& e = p.edges[r.edgeId];
      std::cout << "reason: required edge " << r.edgeId << " (" << e.u << "->"
                << e.v << "):";
      if (r.tailUnreachable)
        std::cout << " start cannot reach tail " << e.u << ";";
      if (r.headCannotReturn)
        std::cout << " head " << e.v << " cannot return to start;";
      std::cout << "\n";
    }
    return 0;
  }

  std::cout << "status: ok\n";
  std::cout << "cost: " << sol.cost << "\n";
  std::cout << "edges:";
  for (int id : sol.edgeSeq)
    std::cout << " " << id;
  std::cout << "\n";
  std::cout << "coverage:\n";
  for (size_t i = 0; i < p.required.size(); ++i)
    std::cout << "  edge " << p.required[i] << ": " << sol.coverage[i] << "\n";
  return 0;
}
