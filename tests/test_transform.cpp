#include "transform.hpp"

#include <algorithm>
#include <cassert>
#include <iostream>

using namespace ar;

int main() {
  Node root = parse("(top 8 (a b c d))");
  auto cands = enumerate_candidates(root);
  assert(!cands.empty());

  // Every candidate must be syntactically valid: re-parsing its printed
  // form reproduces it exactly.
  for (const Candidate& c : cands)
    assert(parse(print(c.tree)) == c.tree);

  // delete_node at the root replaces the whole tree with 0.
  auto it = std::find_if(cands.begin(), cands.end(), [](const Candidate& c) {
    return c.transform == "delete_node" && c.path.empty();
  });
  assert(it != cands.end());
  assert(print(it->tree) == "0");

  // reduce_int on 8 tries 0, then halving: 4, 2, 1.
  std::vector<std::string> reduced;
  for (const Candidate& c : cands)
    if (c.transform == "reduce_int" && c.path == "1")
      reduced.push_back(print(c.tree));
  assert((reduced == std::vector<std::string>{"(top 0 (a b c d))",
                                              "(top 4 (a b c d))",
                                              "(top 2 (a b c d))",
                                              "(top 1 (a b c d))"}));

  // shorten_list on (a b c d): chunks of 2, then single elements.
  std::vector<std::string> shortened;
  for (const Candidate& c : cands)
    if (c.transform == "shorten_list" && c.path == "2")
      shortened.push_back(print(c.tree));
  assert((shortened == std::vector<std::string>{
                           "(top 8 (c d))", "(top 8 (a b))",
                           "(top 8 (b c d))", "(top 8 (a c d))",
                           "(top 8 (a b d))", "(top 8 (a b c))"}));

  // A one-element list shortens to the empty list; negative ints reduce
  // toward zero.
  auto neg = enumerate_candidates(parse("(f -7)"));
  std::vector<std::string> negs;
  for (const Candidate& c : neg)
    if (c.transform == "reduce_int")
      negs.push_back(print(c.tree));
  assert((negs == std::vector<std::string>{"(f 0)", "(f -3)", "(f -1)"}));
  bool has_empty = false;
  for (const Candidate& c : enumerate_candidates(parse("(x)")))
    if (c.transform == "shorten_list" && print(c.tree) == "()")
      has_empty = true;
  assert(has_empty);

  std::cout << "test_transform: OK\n";
}
