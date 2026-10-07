#pragma once

#include "ast.hpp"

#include <optional>
#include <ostream>
#include <string>
#include <unordered_map>

namespace ar {

// Environment identity mixed into every cache key: oracle command, OS/kernel,
// compiler version, and an optional user-supplied tag. Same input reduced
// under a different environment never reuses cached verdicts.
std::string compute_env_id(const std::string& oracle_cmd,
                           const std::string& extra_id);

// Predicate verdict cache. Keys are "<env_id>:<sha1(print(tree))>", so the
// execution environment is always part of the key. Optional append-only
// file persistence.
class PredicateCache {
public:
  explicit PredicateCache(std::string env_id) : env_id_(std::move(env_id)) {}

  std::string key(const Node& t) const;
  std::optional<bool> lookup(const Node& t);
  void store(const Node& t, bool result);

  void enable_persistence(const std::string& path);

  size_t hits() const { return hits_; }
  size_t misses() const { return misses_; }

private:
  std::string env_id_;
  std::unordered_map<std::string, bool> map_;
  size_t hits_ = 0;
  size_t misses_ = 0;
  std::string persist_path_;
};

// Predicate backed by an external oracle command. The candidate is written
// to a temp file whose path is appended as the last argument; exit status 0
// means the failure reproduces. Each run is bounded by a timeout.
class OraclePredicate {
public:
  // `cache` and `trace` may be null.
  OraclePredicate(std::string cmd, int timeout_sec, PredicateCache* cache,
                  std::ostream* trace);
  ~OraclePredicate();

  bool operator()(const Node& t);   // cached
  bool run_uncached(const Node& t); // always executes the oracle

private:
  bool execute(const Node& t) const;

  std::string cmd_;
  int timeout_sec_;
  PredicateCache* cache_;
  std::ostream* trace_;
  std::string tmpdir_;
  mutable unsigned long counter_ = 0;
};

} // namespace ar
