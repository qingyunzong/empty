#include "reduce.hpp"

#include "transform.hpp"

#include <stdexcept>

namespace ar {

namespace {

std::string json_escape(const std::string& s) {
  std::string out;
  for (char c : s) {
    switch (c) {
    case '"': out += "\\\""; break;
    case '\\': out += "\\\\"; break;
    default:
      if (static_cast<unsigned char>(c) < 0x20) {
        char buf[8];
        std::snprintf(buf, sizeof buf, "\\u%04x", c);
        out += buf;
      } else {
        out += c;
      }
    }
  }
  return out;
}

} // namespace

ReduceResult reduce(const Node& input, const PredicateFn& pred,
                    std::ostream& trace, const ReduceOptions& opts) {
  Node current = input;
  ReduceResult res;
  bool changed = true;
  while (changed) {
    changed = false;
    ++res.passes;
    for (const Candidate& cand : enumerate_candidates(current)) {
      if (res.trials >= opts.max_trials) {
        res.limit_hit = true;
        break;
      }
      if (opts.validate_syntax && parse(print(cand.tree)) != cand.tree)
        throw std::logic_error("transformation produced invalid syntax at " +
                               cand.path);
      ++res.trials;
      bool keep = pred(cand.tree);
      trace << "{\"type\":\"trial\",\"n\":" << res.trials
            << ",\"pass\":" << res.passes << ",\"path\":\""
            << json_escape(cand.path) << "\",\"transform\":\"" << cand.transform
            << "\",\"detail\":\"" << json_escape(cand.detail)
            << "\",\"accepted\":" << (keep ? "true" : "false") << "}\n";
      if (keep) {
        current = cand.tree;
        changed = true;
        break; // restart enumeration on the new tree
      }
    }
    if (res.limit_hit)
      break;
  }
  trace << "{\"type\":\"done\",\"trials\":" << res.trials
        << ",\"passes\":" << res.passes << ",\"limit_hit\":"
        << (res.limit_hit ? "true" : "false") << ",\"one_minimal\":"
        << (res.limit_hit ? "false" : "true") << "}\n";
  res.tree = std::move(current);
  return res;
}

} // namespace ar
