#include "ast.hpp"

#include <cassert>
#include <iostream>

using namespace ar;

static void expect_parse_error(const std::string& s) {
  try {
    parse(s);
  } catch (const ParseError&) {
    return;
  }
  std::cerr << "expected ParseError for: " << s << "\n";
  std::abort();
}

int main() {
  // Roundtrip on a nested tree.
  Node n = parse("(prog (def f 1 -2 3) (call g 10) ())");
  assert(print(n) == "(prog (def f 1 -2 3) (call g 10) ())");
  assert(parse(print(n)) == n);
  assert(node_count(n) == 13);

  // Atoms and whitespace/comments.
  assert(print(parse("42")) == "42");
  assert(print(parse("-7")) == "-7");
  assert(print(parse("hello-world")) == "hello-world");
  assert(print(parse("  ; comment\n ( a\tb ) ; tail\n")) == "(a b)");
  assert(print(parse("()")) == "()");

  // Structure.
  Node m = parse("(a (b c) 3)");
  assert(m.kind == Node::Kind::List);
  assert(m.children.size() == 3);
  assert(m.children[0] == Node::symbol("a"));
  assert(m.children[2] == Node::integer(3));
  assert(m.children[1].children[1] == Node::symbol("c"));

  // Malformed inputs must be rejected.
  expect_parse_error("");
  expect_parse_error("   ; only a comment\n");
  expect_parse_error("(");
  expect_parse_error("(a b");
  expect_parse_error(")");
  expect_parse_error("a b");
  expect_parse_error("(a))");
  expect_parse_error("a\"b");

  std::cout << "test_ast: OK\n";
}
