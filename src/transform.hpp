#pragma once

#include "ast.hpp"

#include <string>
#include <vector>

namespace ar {

// One single-step local transformation of a tree.
struct Candidate {
  Node tree;
  std::string path;      // child indices from the root, '/'-separated; "" = root
  std::string transform; // delete_node | reduce_int | shorten_list
  std::string detail;    // human-readable description
};

// Enumerates every single-step local transformation of `root`:
//   delete_node  - replace any subtree by the literal 0
//   reduce_int   - drive an integer literal toward 0 (0, then halving)
//   shorten_list - remove a contiguous chunk of list elements (ddmin-style)
// Nodes are visited in BFS order so large deletions are attempted first.
// Every candidate is syntactically valid by construction.
std::vector<Candidate> enumerate_candidates(const Node& root);

Node replace_at(const Node& root, const std::vector<size_t>& path,
                const Node& replacement);
Node remove_children_at(const Node& root, const std::vector<size_t>& path,
                        size_t start, size_t len);

} // namespace ar
