#include "ast.hpp"
#include "predicate.hpp"
#include "reduce.hpp"
#include "sha1.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace {

constexpr int EXIT_USAGE = 1;
constexpr int EXIT_BAD_PREDICATE = 2; // does not hold, or unstable, on input
constexpr int EXIT_POSTCHECK = 3;     // failure vanished after reduction
constexpr int EXIT_TRIAL_LIMIT = 4;

void usage(std::ostream& os) {
  os << "usage: ast-reduce --oracle CMD --input FILE [options]\n"
        "\n"
        "Reduces an S-expression test case while CMD keeps exiting 0.\n"
        "CMD is run as `timeout SEC CMD <candidate-file>`; exit 0 means the\n"
        "failure reproduces.\n"
        "\n"
        "options:\n"
        "  --output FILE    reduced output (default: stdout; '-' = stdout)\n"
        "  --trace FILE     full trial trace, JSON Lines (default: stderr)\n"
        "  --env-id S       extra tag mixed into cache keys\n"
        "  --max-trials N   bound on predicate evaluations (default: 100000)\n"
        "  --timeout SEC    per-run oracle timeout (default: 10)\n"
        "  --cache-file F   persistent predicate cache\n"
        "  --no-validate    skip re-parsing each candidate (not recommended)\n"
        "  --help           show this text\n";
}

std::string read_all(std::istream& is) {
  std::ostringstream ss;
  ss << is.rdbuf();
  return ss.str();
}

} // namespace

int main(int argc, char** argv) {
  std::string oracle_cmd, input_path, output_path = "-", trace_path = "-",
              extra_id, cache_file;
  size_t max_trials = 100000;
  int timeout_sec = 10;
  bool validate = true;

  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto need = [&](const char* name) -> std::string {
      if (i + 1 >= argc) {
        std::cerr << "error: " << name << " requires an argument\n";
        std::exit(EXIT_USAGE);
      }
      return argv[++i];
    };
    if (a == "--oracle") oracle_cmd = need("--oracle");
    else if (a == "--input") input_path = need("--input");
    else if (a == "--output") output_path = need("--output");
    else if (a == "--trace") trace_path = need("--trace");
    else if (a == "--env-id") extra_id = need("--env-id");
    else if (a == "--max-trials") max_trials = std::stoull(need("--max-trials"));
    else if (a == "--timeout") timeout_sec = std::stoi(need("--timeout"));
    else if (a == "--cache-file") cache_file = need("--cache-file");
    else if (a == "--no-validate") validate = false;
    else if (a == "--help") { usage(std::cout); return 0; }
    else {
      std::cerr << "error: unknown option " << a << "\n";
      usage(std::cerr);
      return EXIT_USAGE;
    }
  }
  if (oracle_cmd.empty() || input_path.empty()) {
    usage(std::cerr);
    return EXIT_USAGE;
  }

  std::string text;
  if (input_path == "-") {
    text = read_all(std::cin);
  } else {
    std::ifstream f(input_path);
    if (!f) {
      std::cerr << "error: cannot open " << input_path << "\n";
      return EXIT_USAGE;
    }
    text = read_all(f);
  }

  ar::Node input;
  try {
    input = ar::parse(text);
  } catch (const ar::ParseError& e) {
    std::cerr << "error: invalid input: " << e.what() << "\n";
    return EXIT_USAGE;
  }

  std::ofstream trace_file;
  std::ostream* trace = &std::cerr;
  if (trace_path != "-") {
    trace_file.open(trace_path);
    if (!trace_file) {
      std::cerr << "error: cannot open trace file " << trace_path << "\n";
      return EXIT_USAGE;
    }
    trace = &trace_file;
  }

  const std::string env_id = ar::compute_env_id(oracle_cmd, extra_id);
  ar::PredicateCache cache(env_id);
  if (!cache_file.empty())
    cache.enable_persistence(cache_file);
  ar::OraclePredicate oracle(oracle_cmd, timeout_sec, &cache, trace);

  // Bad-predicate verification on the finite input AST: the failure must
  // genuinely reproduce, and the oracle must be deterministic.
  bool first = oracle.run_uncached(input);
  bool second = oracle.run_uncached(input);
  if (first != second) {
    std::cerr << "error: predicate is unstable on the original input "
                 "(bad predicate)\n";
    return EXIT_BAD_PREDICATE;
  }
  if (!first) {
    std::cerr << "error: predicate does not hold on the original input "
                 "(not a reproducer)\n";
    return EXIT_BAD_PREDICATE;
  }

  *trace << "{\"type\":\"start\",\"env_id\":\"" << env_id
         << "\",\"input_hash\":\"" << ar::sha1_hex(ar::print(input))
         << "\",\"input_nodes\":" << ar::node_count(input) << "}\n";

  ar::ReduceOptions opts;
  opts.max_trials = max_trials;
  opts.validate_syntax = validate;
  ar::ReduceResult res = ar::reduce(input, std::ref(oracle), *trace, opts);

  // Post-reduction verification, bypassing the cache: the failure must
  // still genuinely reproduce on the reduced AST.
  if (!oracle.run_uncached(res.tree)) {
    std::cerr << "error: post-reduction verification failed: predicate no "
                 "longer holds\n";
    return EXIT_POSTCHECK;
  }

  std::string out_text = ar::print(res.tree) + "\n";
  if (output_path == "-") {
    std::cout << out_text;
  } else {
    std::ofstream f(output_path);
    if (!f) {
      std::cerr << "error: cannot write " << output_path << "\n";
      return EXIT_USAGE;
    }
    f << out_text;
  }

  std::cerr << "ast-reduce: " << ar::node_count(input) << " -> "
            << ar::node_count(res.tree) << " nodes, " << res.trials
            << " trials in " << res.passes << " passes (cache: "
            << cache.hits() << " hits, " << cache.misses() << " misses)\n";
  if (res.limit_hit) {
    std::cerr << "warning: trial limit reached; result is NOT 1-minimal\n";
    return EXIT_TRIAL_LIMIT;
  }
  return 0;
}
