#include "checker.hpp"

#include <fstream>
#include <iostream>
#include <string>

namespace {

void usage(std::ostream& os, const char* argv0) {
    os << "usage: " << argv0
       << " [--modulus M] [--window W] [--reference-check] <logfile|->\n"
          "\n"
          "Verify per-stream unique, prefix-ordered delivery from a packet log.\n"
          "Retransmissions do not count as new deliveries; streams may\n"
          "interleave arbitrarily. Raw sequence numbers wrap modulo M and are\n"
          "disambiguated within a window of W around the next expected seq\n"
          "(requires 2*W <= M).\n"
          "\n"
          "log format: one packet per line: '<stream_id> <seq>' ('#' comments)\n"
          "\n"
          "options:\n"
          "  --modulus M        sequence number modulus (default 16)\n"
          "  --window W         disambiguation window (default 8)\n"
          "  --reference-check  cross-verify with exhaustive reference search\n"
          "                     (small modulus/window only)\n"
          "  -h, --help         show this help\n"
          "\n"
          "exit code: 0 = no conflict, 1 = conflict found, 2 = usage/io error\n";
}

} // namespace

int main(int argc, char** argv) {
    std::uint64_t modulus = 16, window = 8;
    bool reference_check = false;
    std::string path;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto need_value = [&](const char* name) -> const char* {
            if (i + 1 >= argc) {
                std::cerr << "error: " << name << " requires a value\n";
                std::exit(2);
            }
            return argv[++i];
        };
        if (arg == "--modulus") {
            modulus = std::stoull(need_value("--modulus"));
        } else if (arg == "--window") {
            window = std::stoull(need_value("--window"));
        } else if (arg == "--reference-check") {
            reference_check = true;
        } else if (arg == "-h" || arg == "--help") {
            usage(std::cout, argv[0]);
            return 0;
        } else if (!arg.empty() && arg[0] == '-' && arg != "-") {
            std::cerr << "error: unknown option '" << arg << "'\n";
            usage(std::cerr, argv[0]);
            return 2;
        } else if (path.empty()) {
            path = arg;
        } else {
            std::cerr << "error: multiple input files given\n";
            return 2;
        }
    }

    if (const std::string err = seqcheck::validate_params(modulus, window);
        !err.empty()) {
        std::cerr << "error: " << err << "\n";
        return 2;
    }

    // Parse once; keep the packets so the reference checker can replay them.
    seqcheck::ParseResult parsed;
    {
        std::ifstream file;
        std::istream* in = &std::cin;
        if (!path.empty() && path != "-") {
            file.open(path);
            if (!file) {
                std::cerr << "error: cannot open '" << path << "'\n";
                return 2;
            }
            in = &file;
        }
        parsed = seqcheck::parse_log(*in);
    }

    seqcheck::CheckResult result;
    if (parsed.conflict) {
        result.conflict = std::move(parsed.conflict);
    } else {
        result = seqcheck::check_packets(parsed.packets, modulus, window);
    }

    if (reference_check && !parsed.packets.empty()) {
        const bool ref =
            seqcheck::reference_consistent(parsed.packets, modulus, window);
        const bool main_ok = !result.conflict;
        if (ref != main_ok) {
            std::cerr << "error: reference-check mismatch: main checker says "
                      << (main_ok ? "OK" : "CONFLICT")
                      << " but exhaustive reference says "
                      << (ref ? "consistent" : "inconsistent") << "\n";
            return 2;
        }
        std::cerr << "reference-check: exhaustive search agrees ("
                  << (ref ? "consistent" : "inconsistent") << ")\n";
    }

    if (result.conflict) {
        const seqcheck::Conflict& c = *result.conflict;
        std::cout << "CONFLICT line " << c.line_no << ": " << c.message << "\n"
                  << "evidence: line " << c.line_no << ": \"" << c.evidence
                  << "\"\n";
        if (c.kind != seqcheck::ConflictKind::Parse) {
            std::cout << "context: stream " << c.stream << " next expected abs seq "
                      << c.expected << " (raw " << c.expected % modulus
                      << " mod " << modulus << "), window "
                      << (c.expected > window ? c.expected - window : 0)
                      << ".." << (c.expected + window - 1) << "\n";
        }
        std::cout << "stats before conflict: " << result.stats.packets
                  << " packets, " << result.stats.delivered << " delivered, "
                  << result.stats.retrans << " retransmissions, "
                  << result.stats.streams << " stream(s)\n";
        return 1;
    }

    std::cout << "OK: " << result.stats.packets << " packets, "
              << result.stats.delivered << " delivered, " << result.stats.retrans
              << " retransmissions ignored, " << result.stats.streams
              << " stream(s); per-stream prefix order verified (modulus "
              << modulus << ", window " << window << ")\n";
    return 0;
}
