#pragma once

#include <stdexcept>
#include <string>
#include <vector>

namespace ar {

// AST for a small S-expression language:
//   expr := INT | SYM | '(' expr* ')'
struct Node {
  enum class Kind { Int, Sym, List };

  Kind kind = Kind::Int;
  long long value = 0;          // Kind::Int
  std::string sym;              // Kind::Sym
  std::vector<Node> children;   // Kind::List

  static Node integer(long long v) {
    Node n;
    n.kind = Kind::Int;
    n.value = v;
    return n;
  }
  static Node symbol(std::string s) {
    Node n;
    n.kind = Kind::Sym;
    n.sym = std::move(s);
    return n;
  }
  static Node list(std::vector<Node> c) {
    Node n;
    n.kind = Kind::List;
    n.children = std::move(c);
    return n;
  }

  friend bool operator==(const Node&, const Node&) = default;
};

struct ParseError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Parses exactly one expression; throws ParseError on malformed input.
Node parse(const std::string& text);

// Canonical printing; parse(print(n)) == n always holds.
std::string print(const Node& n);

size_t node_count(const Node& n);

} // namespace ar
