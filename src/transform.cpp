#include "transform.hpp"

#include <algorithm>
#include <queue>

namespace ar {

namespace {

std::string path_str(const std::vector<size_t>& path) {
  std::string s;
  for (size_t i = 0; i < path.size(); ++i) {
    if (i)
      s += '/';
    s += std::to_string(path[i]);
  }
  return s;
}

// Values to try when reducing `v` toward zero: 0 first, then halving.
std::vector<long long> reduce_values(long long v) {
  std::vector<long long> out;
  if (v == 0)
    return out;
  out.push_back(0);
  long long cur = v;
  while (cur != 0) {
    cur /= 2;
    if (cur != 0)
      out.push_back(cur);
  }
  return out;
}

Node replace_at_rec(const Node& n, const std::vector<size_t>& path,
                    size_t depth, const Node& replacement) {
  if (depth == path.size())
    return replacement;
  Node copy = n;
  copy.children[path[depth]] =
      replace_at_rec(n.children[path[depth]], path, depth + 1, replacement);
  return copy;
}

Node remove_children_rec(const Node& n, const std::vector<size_t>& path,
                         size_t depth, size_t start, size_t len) {
  Node copy = n;
  if (depth == path.size()) {
    auto& cs = copy.children;
    cs.erase(cs.begin() + static_cast<long>(start),
             cs.begin() + static_cast<long>(start + len));
    return copy;
  }
  copy.children[path[depth]] = remove_children_rec(
      n.children[path[depth]], path, depth + 1, start, len);
  return copy;
}

} // namespace

Node replace_at(const Node& root, const std::vector<size_t>& path,
                const Node& replacement) {
  return replace_at_rec(root, path, 0, replacement);
}

Node remove_children_at(const Node& root, const std::vector<size_t>& path,
                        size_t start, size_t len) {
  return remove_children_rec(root, path, 0, start, len);
}

std::vector<Candidate> enumerate_candidates(const Node& root) {
  std::vector<Candidate> out;

  std::queue<std::pair<std::vector<size_t>, const Node*>> q;
  q.push({{}, &root});
  while (!q.empty()) {
    auto [path, node] = q.front();
    q.pop();
    std::string ps = path_str(path);

    // delete_node: replace this subtree by the literal 0.
    if (!(node->kind == Node::Kind::Int && node->value == 0)) {
      out.push_back({replace_at(root, path, Node::integer(0)), ps,
                     "delete_node", "replace subtree with 0"});
    }

    // reduce_int: drive an integer literal toward 0.
    if (node->kind == Node::Kind::Int) {
      for (long long v : reduce_values(node->value)) {
        out.push_back({replace_at(root, path, Node::integer(v)), ps,
                       "reduce_int",
                       std::to_string(node->value) + "->" + std::to_string(v)});
      }
    }

    // shorten_list: remove contiguous chunks, coarse to fine (ddmin-style).
    if (node->kind == Node::Kind::List && !node->children.empty()) {
      size_t n = node->children.size();
      for (size_t chunk = std::max(n / 2, size_t{1}); chunk >= 1; chunk /= 2) {
        for (size_t start = 0; start < n; start += chunk) {
          size_t len = std::min(chunk, n - start);
          out.push_back({remove_children_at(root, path, start, len), ps,
                         "shorten_list",
                         "remove " + std::to_string(len) + " of " +
                             std::to_string(n) + " elements at " +
                             std::to_string(start)});
        }
      }
    }

    for (size_t i = 0; i < node->children.size(); ++i) {
      auto cp = path;
      cp.push_back(i);
      q.push({std::move(cp), &node->children[i]});
    }
  }
  return out;
}

} // namespace ar
