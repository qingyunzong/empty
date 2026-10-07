#pragma once

// AST-based test-case reducer.
//
// Local transformations (each candidate is syntactically valid by
// construction and re-checked by a parse(print(x)) round-trip):
//   * shrink-int    : replace an integer leaf n != 0 by n/2 (and 0)
//   * delete-node   : replace a list node by one of its children
//   * shorten-list  : remove single elements / contiguous chunks (ddmin-style)
//
// A candidate is accepted only if the bad-predicate still holds, i.e. the
// failure genuinely reproduces. The fixpoint is a local minimum: no single
// local transformation yields a smaller bad AST.
//
// Predicate verdicts are cached under a key that includes the execution
// environment id, and every predicate query is recorded in the trajectory.

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

#include <sys/utsname.h>

namespace reducer {

// ---------------------------------------------------------------- AST ------

struct Node {
  using List = std::vector<Node>;
  std::variant<int64_t, std::string, List> value;

  static Node integer(int64_t i) { return Node{i}; }
  static Node symbol(std::string s) { return Node{std::move(s)}; }
  static Node list(List l) { return Node{std::move(l)}; }

  bool operator==(const Node&) const = default;

  const int64_t* as_int() const { return std::get_if<int64_t>(&value); }
  const std::string* as_symbol() const { return std::get_if<std::string>(&value); }
  const List* as_list() const { return std::get_if<List>(&value); }
};

inline size_t ast_size(const Node& n) {
  if (const auto* l = n.as_list()) {
    size_t s = 1;
    for (const auto& c : *l) s += ast_size(c);
    return s;
  }
  return 1;
}

// Reduction cost: node count plus integer magnitudes. Every local
// transformation (shrink-int, delete-node, shorten-list) strictly decreases
// this measure, which guarantees termination of the fixpoint loop.
inline uint64_t program_cost(const Node& n) {
  if (const auto* i = n.as_int()) {
    const uint64_t mag =
        *i < 0 ? ~static_cast<uint64_t>(*i) + 1 : static_cast<uint64_t>(*i);
    return 1 + mag;
  }
  if (const auto* l = n.as_list()) {
    uint64_t s = 1;
    for (const auto& c : *l) s += program_cost(c);
    return s;
  }
  return 1;
}

inline void print_ast(const Node& n, std::string& out) {
  if (const auto* i = n.as_int()) {
    out += std::to_string(*i);
    return;
  }
  if (const auto* s = n.as_symbol()) {
    out += *s;
    return;
  }
  const auto& l = *n.as_list();
  out += '(';
  for (size_t k = 0; k < l.size(); ++k) {
    if (k) out += ' ';
    print_ast(l[k], out);
  }
  out += ')';
}

inline std::string print_ast(const Node& n) {
  std::string out;
  print_ast(n, out);
  return out;
}

// ------------------------------------------------------------- parser ------

class ParseError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

inline bool looks_like_int(std::string_view t) {
  size_t i = 0;
  if (i < t.size() && t[i] == '-') ++i;
  if (i >= t.size() || !std::isdigit(static_cast<unsigned char>(t[i])))
    return false;
  for (; i < t.size(); ++i)
    if (!std::isdigit(static_cast<unsigned char>(t[i]))) return false;
  return true;
}

class Parser {
 public:
  explicit Parser(std::string_view src) : src_(src) {}

  Node parse() {
    Node n = parse_node();
    skip_ws();
    if (pos_ != src_.size()) throw ParseError("trailing input after top-level node");
    return n;
  }

 private:
  void skip_ws() {
    while (pos_ < src_.size() && std::isspace(static_cast<unsigned char>(src_[pos_])))
      ++pos_;
  }

  Node parse_node() {
    skip_ws();
    if (pos_ >= src_.size()) throw ParseError("unexpected end of input");
    if (src_[pos_] == '(') {
      ++pos_;
      Node::List items;
      while (true) {
        skip_ws();
        if (pos_ >= src_.size()) throw ParseError("unclosed '('");
        if (src_[pos_] == ')') {
          ++pos_;
          break;
        }
        items.push_back(parse_node());
      }
      return Node::list(std::move(items));
    }
    if (src_[pos_] == ')') throw ParseError("unexpected ')'");
    const size_t start = pos_;
    while (pos_ < src_.size() && !std::isspace(static_cast<unsigned char>(src_[pos_])) &&
           src_[pos_] != '(' && src_[pos_] != ')')
      ++pos_;
    std::string tok(src_.substr(start, pos_ - start));
    if (looks_like_int(tok)) {
      try {
        return Node::integer(std::stoll(tok));
      } catch (const std::out_of_range&) {
        throw ParseError("integer literal out of range: " + tok);
      }
    }
    return Node::symbol(std::move(tok));
  }

  std::string_view src_;
  size_t pos_ = 0;
};

inline Node parse(std::string_view src) { return Parser(src).parse(); }

// ---------------------------------------------------- interpreter / bug ----

struct Crash {};         // the target failure: division by zero
struct SemanticError {}; // any other error: NOT the target failure

inline int64_t eval(const Node& n) {
  if (const auto* i = n.as_int()) return *i;
  if (n.as_symbol()) throw SemanticError{};
  const auto& l = *n.as_list();
  if (l.empty()) throw SemanticError{};
  const auto* head = l[0].as_symbol();
  if (!head) throw SemanticError{};
  if (*head == "seq") {
    if (l.size() < 2) throw SemanticError{};
    int64_t r = 0;
    for (size_t k = 1; k < l.size(); ++k) r = eval(l[k]);
    return r;
  }
  if (*head == "add" || *head == "sub" || *head == "mul" || *head == "div") {
    if (l.size() != 3) throw SemanticError{};
    const int64_t a = eval(l[1]);
    const int64_t b = eval(l[2]);
    if (*head == "add") return a + b;
    if (*head == "sub") return a - b;
    if (*head == "mul") return a * b;
    if (b == 0) throw Crash{};
    return a / b;
  }
  throw SemanticError{};
}

// Bad-predicate: true iff the program genuinely reproduces the target crash.
inline bool reproduces_crash(const Node& n) {
  try {
    (void)eval(n);
    return false;
  } catch (const Crash&) {
    return true;
  } catch (const SemanticError&) {
    return false;
  }
}

// ------------------------------------------------------- environment id ----

inline std::string environment_id() {
  if (const char* override_id = std::getenv("REDUCER_ENV_ID"))
    if (*override_id) return override_id;
  utsname u{};
  std::string id = "unknown-os";
  if (uname(&u) == 0)
    id = std::string(u.sysname) + "-" + u.release + "-" + u.machine;
  id += "-cxx" + std::to_string(__cplusplus);
  return id;
}

// ------------------------------------------------------- transformations ----

using Transform = std::vector<Node> (*)(const Node&);

inline std::vector<Node> shrink_ints(const Node& n) {
  std::vector<Node> out;
  if (const auto* i = n.as_int()) {
    if (*i != 0) {
      out.push_back(Node::integer(*i / 2));
      if (*i / 2 != 0) out.push_back(Node::integer(0));
    }
    return out;
  }
  if (const auto* l = n.as_list()) {
    for (size_t k = 0; k < l->size(); ++k)
      for (auto& c : shrink_ints((*l)[k])) {
        auto copy = *l;
        copy[k] = std::move(c);
        out.push_back(Node::list(std::move(copy)));
      }
  }
  return out;
}

inline std::vector<Node> delete_nodes(const Node& n) {
  std::vector<Node> out;
  const auto* l = n.as_list();
  if (!l) return out;
  for (const auto& child : *l) out.push_back(child); // replace node by child
  for (size_t k = 0; k < l->size(); ++k)
    for (auto& c : delete_nodes((*l)[k])) {
      auto copy = *l;
      copy[k] = std::move(c);
      out.push_back(Node::list(std::move(copy)));
    }
  return out;
}

inline std::vector<Node> shorten_lists(const Node& n) {
  std::vector<Node> out;
  if (const auto* l = n.as_list()) {
    const size_t len = l->size();
    if (len >= 2) {
      for (size_t k = 0; k < len; ++k) { // remove single element
        Node::List copy;
        copy.reserve(len - 1);
        for (size_t j = 0; j < len; ++j)
          if (j != k) copy.push_back((*l)[j]);
        out.push_back(Node::list(std::move(copy)));
      }
      for (size_t g = 2; g <= len; g *= 2) { // ddmin-style contiguous chunks
        const size_t chunk = (len + g - 1) / g;
        for (size_t start = 0; start < len; start += chunk) {
          const size_t end = std::min(start + chunk, len);
          if (start == 0 && end == len) continue; // keep at least one element
          Node::List copy;
          for (size_t j = 0; j < len; ++j)
            if (j < start || j >= end) copy.push_back((*l)[j]);
          out.push_back(Node::list(std::move(copy)));
        }
      }
    }
    for (size_t k = 0; k < len; ++k)
      for (auto& c : shorten_lists((*l)[k])) {
        auto copy = *l;
        copy[k] = std::move(c);
        out.push_back(Node::list(std::move(copy)));
      }
  }
  return out;
}

inline const std::pair<const char*, Transform> kTransforms[] = {
    {"shrink-int", &shrink_ints},
    {"delete-node", &delete_nodes},
    {"shorten-list", &shorten_lists},
};

// ---------------------------------------------------------------- reducer --

struct Trial {
  size_t step = 0;
  std::string transform;
  std::string candidate;
  size_t candidate_size = 0;
  uint64_t candidate_cost = 0;
  bool bad = false;
  bool accepted = false;
  bool from_cache = false;
};

struct ReduceResult {
  Node result;
  std::string env_id;
  std::vector<Trial> trajectory;
  size_t cache_hits = 0;
};

class Reducer {
 public:
  Reducer(std::function<bool(const Node&)> is_bad, std::string env_id)
      : is_bad_(std::move(is_bad)), env_id_(std::move(env_id)) {}

  // Cache key: execution environment id + canonical program text.
  std::string cache_key(const Node& n) const {
    return env_id_ + "\x1f" + print_ast(n);
  }

  ReduceResult reduce(const Node& initial) {
    ReduceResult rr;
    rr.env_id = env_id_;
    rr.result = initial;
    if (!query(initial, "initial", rr))
      throw std::runtime_error("initial input does not reproduce the failure");
    rr.trajectory.back().accepted = true;

    bool changed = true;
    while (changed) {
      changed = false;
      for (const auto& [name, tf] : kTransforms) {
        bool accepted = false;
        for (const Node& cand : tf(rr.result)) {
          if (program_cost(cand) >= program_cost(rr.result)) continue;
          if (query(cand, name, rr)) {
            rr.result = cand;
            rr.trajectory.back().accepted = true;
            changed = true;
            accepted = true;
            break;
          }
        }
        if (accepted) break;
      }
    }
    return rr;
  }

 private:
  bool query(const Node& n, const std::string& transform, ReduceResult& rr) {
    const std::string key = cache_key(n);
    bool bad;
    bool from_cache = false;
    if (const auto it = cache_.find(key); it != cache_.end()) {
      bad = it->second;
      from_cache = true;
      ++rr.cache_hits;
    } else {
      bad = is_bad_(n);
      cache_.emplace(key, bad);
    }
    Trial t;
    t.step = rr.trajectory.size();
    t.transform = transform;
    t.candidate = print_ast(n);
    t.candidate_size = ast_size(n);
    t.candidate_cost = program_cost(n);
    t.bad = bad;
    t.from_cache = from_cache;
    rr.trajectory.push_back(std::move(t));
    return bad;
  }

  std::function<bool(const Node&)> is_bad_;
  std::string env_id_;
  std::unordered_map<std::string, bool> cache_;
};

inline std::string format_trajectory(const ReduceResult& rr) {
  std::ostringstream os;
  os << "# env: " << rr.env_id << '\n';
  os << "# step | transform | size | cost | verdict | action | candidate\n";
  for (const Trial& t : rr.trajectory) {
    os << t.step << " | " << t.transform << " | " << t.candidate_size << " | "
       << t.candidate_cost << " | "
       << (t.bad ? "BAD" : "good") << " | " << (t.accepted ? "accept" : "reject")
       << (t.from_cache ? " (cached)" : "") << " | " << t.candidate << '\n';
  }
  return os.str();
}

// True iff no single local transformation yields a smaller bad AST.
inline bool is_local_minimum(const Node& n, const std::function<bool(const Node&)>& pred) {
  for (const auto& [name, tf] : kTransforms)
    for (const Node& c : tf(n))
      if (program_cost(c) < program_cost(n) && pred(c)) return false;
  return true;
}

// ------------------------------------------- bounded predicate verification --

// Enumerate every AST with at most max_size nodes over a fixed small alphabet.
inline std::vector<Node> enumerate_asts(size_t max_size) {
  std::vector<std::vector<Node>> by_size(max_size + 1);
  by_size[1] = {Node::integer(0), Node::integer(1), Node::symbol("add"),
                Node::symbol("div")};
  const std::string heads[] = {"add", "div"};
  for (size_t s = 2; s <= max_size; ++s) {
    std::vector<Node::List> child_lists;
    std::function<void(size_t, Node::List&)> gen = [&](size_t remaining, Node::List& acc) {
      if (remaining == 0) {
        if (!acc.empty()) child_lists.push_back(acc);
        return;
      }
      for (size_t cs = 1; cs <= remaining; ++cs)
        for (const Node& c : by_size[cs]) {
          acc.push_back(c);
          gen(remaining - cs, acc);
          acc.pop_back();
        }
    };
    Node::List acc;
    gen(s - 1, acc);
    for (const auto& cl : child_lists)
      for (const auto& h : heads) {
        Node::List l;
        l.reserve(cl.size() + 1);
        l.push_back(Node::symbol(h));
        for (const auto& c : cl) l.push_back(c);
        by_size[s].push_back(Node::list(std::move(l)));
      }
  }
  std::vector<Node> all;
  for (size_t s = 1; s <= max_size; ++s)
    for (auto& n : by_size[s]) all.push_back(std::move(n));
  return all;
}

struct VerifyReport {
  bool ok = true;
  size_t asts_checked = 0;
  std::string error;
};

// Bounded bad-predicate verification over finite ASTs: every AST up to
// max_size nodes must round-trip through print/parse (syntactic validity),
// the predicate must be deterministic, and cached verdicts must agree with
// fresh evaluations.
inline VerifyReport verify_bounded(const std::function<bool(const Node&)>& pred,
                                   size_t max_size) {
  VerifyReport rep;
  std::unordered_map<std::string, bool> cache;
  for (const Node& a : enumerate_asts(max_size)) {
    ++rep.asts_checked;
    const std::string text = print_ast(a);
    Node reparsed = Node::integer(0);
    try {
      reparsed = parse(text);
    } catch (const std::exception& e) {
      rep.ok = false;
      rep.error = "unparseable printed AST '" + text + "': " + e.what();
      return rep;
    }
    if (!(reparsed == a)) {
      rep.ok = false;
      rep.error = "print/parse round-trip mismatch: " + text;
      return rep;
    }
    const bool first = pred(a);
    if (pred(a) != first) {
      rep.ok = false;
      rep.error = "nondeterministic predicate on: " + text;
      return rep;
    }
    const auto [it, inserted] = cache.emplace(text, first);
    if (!inserted && it->second != first) {
      rep.ok = false;
      rep.error = "cache/fresh verdict mismatch on: " + text;
      return rep;
    }
  }
  return rep;
}

} // namespace reducer
