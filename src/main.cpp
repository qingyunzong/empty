#include <fstream>
#include <iostream>
#include <string>

#include "checker.hpp"

namespace {

void usage(std::ostream& os, const char* argv0) {
  os << "usage: " << argv0 << " [--modulus N] [--window N] [FILE]\n"
     << "\n"
     << "Verifies a packet log: per stream, every sequence number must be\n"
     << "delivered at most once and deliveries must form a prefix (no gaps).\n"
     << "Retransmissions of an already-delivered sequence number are ignored.\n"
     << "Streams are independent; raw sequence numbers wrap modulo N and are\n"
     << "disambiguated within the given window around the expected position.\n"
     << "\n"
     << "Log format: one packet per line, '<stream> <seq>'; blank lines and\n"
     << "'#' comments are ignored. FILE omitted or '-' reads standard input.\n"
     << "\n"
     << "Exit status: 0 = log accepted, 1 = first conflict reported,\n"
     << "2 = usage or I/O error.\n";
}

bool parse_u64(const char* text, std::uint64_t& out) {
  try {
    size_t used = 0;
    out = std::stoull(text, &used);
    return used == std::string(text).size();
  } catch (...) {
    return false;
  }
}

}  // namespace

int main(int argc, char** argv) {
  seqcheck::Params params;
  std::string path = "-";

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const auto option_value = [&](const char* name, std::uint64_t& out) {
      if (i + 1 >= argc || !parse_u64(argv[i + 1], out)) {
        std::cerr << "error: option " << name << " needs an unsigned integer value\n";
        return false;
      }
      ++i;
      return true;
    };
    if (arg == "--modulus") {
      if (!option_value("--modulus", params.modulus)) return 2;
    } else if (arg == "--window") {
      if (!option_value("--window", params.window)) return 2;
    } else if (arg == "--help" || arg == "-h") {
      usage(std::cout, argv[0]);
      return 0;
    } else if (arg == "-") {
      path = "-";
    } else if (!arg.empty() && arg.front() == '-') {
      std::cerr << "error: unknown option: " << arg << "\n";
      usage(std::cerr, argv[0]);
      return 2;
    } else {
      path = arg;
    }
  }

  if (params.modulus < 2) {
    std::cerr << "error: modulus must be >= 2\n";
    return 2;
  }
  if (params.window < 1 || params.window > params.modulus) {
    std::cerr << "error: window must be in [1, modulus]\n";
    return 2;
  }

  std::ifstream file;
  std::istream* in = &std::cin;
  if (path != "-") {
    file.open(path);
    if (!file) {
      std::cerr << "error: cannot open " << path << "\n";
      return 2;
    }
    in = &file;
  }

  seqcheck::Checker checker(params);
  std::string line;
  std::uint64_t line_no = 0;
  while (std::getline(*in, line)) {
    ++line_no;
    std::string error;
    const auto packet = seqcheck::parse_line(line_no, line, error);
    if (!packet) {
      if (error.empty()) continue;  // blank line or comment
      std::cout << "CONFLICT parse: line " << line_no << ": " << error << "\n"
                << "  packet: \"" << line << "\"\n";
      return 1;
    }
    if (const auto conflict = checker.process(*packet)) {
      const auto& p = conflict->packet;
      std::cout << "CONFLICT " << seqcheck::to_string(conflict->kind) << ": line "
                << p.line_no << " stream " << p.stream << " seq " << p.seq
                << " (expected " << conflict->expected_next % params.modulus
                << ", modulus " << params.modulus << ", window " << params.window
                << ")\n"
                << "  detail: " << conflict->detail << "\n"
                << "  packet: \"" << p.raw << "\"\n";
      return 1;
    }
  }

  const auto& stats = checker.stats();
  std::cout << "OK: " << stats.packets << " packets, " << stats.delivered
            << " delivered, " << stats.retransmissions << " retransmissions, "
            << checker.streams() << " streams (modulus " << params.modulus
            << ", window " << params.window << ")\n";
  return 0;
}
