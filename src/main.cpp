// CLI: reduce a program file to a local minimum that still reproduces the
// div-by-zero crash, printing the full trial trajectory.
//
//   reduce <file>        reduce program read from <file> ("-" for stdin)
//   reduce verify [N]    bounded bad-predicate verification over ASTs of
//                        size <= N (default 5)

#include <fstream>
#include <iostream>
#include <iterator>
#include <string>

#include "reducer.hpp"

int main(int argc, char** argv) {
  using namespace reducer;
  if (argc < 2) {
    std::cerr << "usage: reduce <file|-> | reduce verify [max_size]\n";
    return 2;
  }
  const std::string cmd = argv[1];

  if (cmd == "verify") {
    const size_t max_size = argc > 2 ? std::stoul(argv[2]) : 5;
    const VerifyReport rep = verify_bounded(reproduces_crash, max_size);
    std::cout << "checked " << rep.asts_checked << " ASTs up to size " << max_size
              << ": " << (rep.ok ? "OK" : "FAILED") << '\n';
    if (!rep.ok) std::cerr << rep.error << '\n';
    return rep.ok ? 0 : 1;
  }

  std::string src;
  if (cmd == "-") {
    src.assign(std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>());
  } else {
    std::ifstream in(cmd);
    if (!in) {
      std::cerr << "cannot open " << cmd << '\n';
      return 2;
    }
    src.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  }

  try {
    const Node initial = parse(src);
    Reducer r(reproduces_crash, environment_id());
    const ReduceResult rr = r.reduce(initial);
    std::cout << "# reduced program (" << ast_size(rr.result) << " nodes, cost "
              << program_cost(rr.result) << "):\n"
              << print_ast(rr.result) << "\n\n"
              << format_trajectory(rr);
    std::cout << "# trials: " << rr.trajectory.size() << ", cache hits: " << rr.cache_hits
              << ", local minimum: "
              << (is_local_minimum(rr.result, reproduces_crash) ? "yes" : "no") << '\n';
  } catch (const std::exception& e) {
    std::cerr << "error: " << e.what() << '\n';
    return 1;
  }
  return 0;
}
