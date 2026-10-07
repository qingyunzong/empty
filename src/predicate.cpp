#include "predicate.hpp"

#include "sha1.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <unistd.h>

namespace ar {

std::string compute_env_id(const std::string& oracle_cmd,
                           const std::string& extra_id) {
  struct utsname uts {};
  if (uname(&uts) != 0)
    throw std::runtime_error("uname() failed");
  std::string material = "ast-reduce/1\n";
  material += "oracle:" + oracle_cmd + "\n";
  material += "os:";
  material += uts.sysname;
  material += ' ';
  material += uts.release;
  material += ' ';
  material += uts.machine;
  material += "\ncompiler:";
  material += __VERSION__;
  material += "\nextra:" + extra_id;
  return sha1_hex(material).substr(0, 16);
}

std::string PredicateCache::key(const Node& t) const {
  return env_id_ + ":" + sha1_hex(print(t));
}

std::optional<bool> PredicateCache::lookup(const Node& t) {
  auto it = map_.find(key(t));
  if (it != map_.end()) {
    ++hits_;
    return it->second;
  }
  ++misses_;
  return std::nullopt;
}

void PredicateCache::store(const Node& t, bool result) {
  std::string k = key(t);
  map_[k] = result;
  if (!persist_path_.empty()) {
    std::ofstream f(persist_path_, std::ios::app);
    f << k << ' ' << (result ? 1 : 0) << '\n';
  }
}

void PredicateCache::enable_persistence(const std::string& path) {
  persist_path_ = path;
  std::ifstream f(path);
  std::string k;
  int v;
  while (f >> k >> v)
    map_.emplace(k, v != 0);
}

OraclePredicate::OraclePredicate(std::string cmd, int timeout_sec,
                                 PredicateCache* cache, std::ostream* trace)
    : cmd_(std::move(cmd)), timeout_sec_(timeout_sec), cache_(cache),
      trace_(trace) {
  namespace fs = std::filesystem;
  tmpdir_ = (fs::temp_directory_path() /
             ("ast-reduce-" + std::to_string(::getpid())))
                .string();
  fs::create_directories(tmpdir_);
}

OraclePredicate::~OraclePredicate() {
  std::error_code ec;
  std::filesystem::remove_all(tmpdir_, ec);
}

bool OraclePredicate::execute(const Node& t) const {
  std::string path =
      tmpdir_ + "/cand-" + std::to_string(counter_++) + ".sexp";
  {
    std::ofstream f(path);
    if (!f)
      throw std::runtime_error("cannot write candidate file " + path);
    f << print(t) << '\n';
  }
  std::string full = "timeout " + std::to_string(timeout_sec_) + " " + cmd_ +
                     " '" + path + "'";
  int rc = std::system(full.c_str());
  return rc != -1 && WIFEXITED(rc) && WEXITSTATUS(rc) == 0;
}

bool OraclePredicate::operator()(const Node& t) {
  bool hit = false;
  bool result = false;
  if (cache_) {
    if (auto v = cache_->lookup(t)) {
      hit = true;
      result = *v;
    }
  }
  if (!hit) {
    result = execute(t);
    if (cache_)
      cache_->store(t, result);
  }
  if (trace_) {
    *trace_ << "{\"type\":\"oracle\",\"hash\":\"" << sha1_hex(print(t))
            << "\",\"cache\":\"" << (hit ? "hit" : "miss")
            << "\",\"keep\":" << (result ? "true" : "false") << "}\n";
  }
  return result;
}

bool OraclePredicate::run_uncached(const Node& t) { return execute(t); }

} // namespace ar
