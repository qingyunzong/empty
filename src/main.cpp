#include <charconv>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "sigconv/convolve.hpp"

namespace {

constexpr size_t kMaxTotalLength = 200000;

std::vector<int64_t> parse_sequence(const std::string& text, const std::string& origin) {
    std::vector<int64_t> seq;
    std::istringstream in(text);
    std::string tok;
    while (in >> tok) {
        int64_t v = 0;
        const char* first = tok.data();
        const char* last = tok.data() + tok.size();
        auto res = std::from_chars(first, last, v);
        if (res.ec != std::errc() || res.ptr != last)
            throw std::runtime_error("invalid int64 literal '" + tok + "' in " + origin);
        seq.push_back(v);
    }
    if (seq.empty()) throw std::runtime_error("empty sequence in " + origin);
    return seq;
}

std::string read_all(std::istream& in) {
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

[[noreturn]] void usage() {
    std::cerr << "usage:\n"
                 "  sigconv <fileA> <fileB>   convolve two whitespace-separated int64 sequences\n"
                 "  sigconv                   read sequence A from stdin line 1, B from line 2\n";
    std::exit(2);
}

} // namespace

int main(int argc, char** argv) {
    std::vector<int64_t> a, b;
    try {
        if (argc == 1) {
            std::string line_a, line_b;
            if (!std::getline(std::cin, line_a) || !std::getline(std::cin, line_b))
                throw std::runtime_error("expected two lines on stdin (sequence A, then sequence B)");
            a = parse_sequence(line_a, "stdin line 1");
            b = parse_sequence(line_b, "stdin line 2");
        } else if (argc == 3) {
            std::ifstream fa(argv[1]), fb(argv[2]);
            if (!fa) throw std::runtime_error(std::string("cannot open ") + argv[1]);
            if (!fb) throw std::runtime_error(std::string("cannot open ") + argv[2]);
            a = parse_sequence(read_all(fa), argv[1]);
            b = parse_sequence(read_all(fb), argv[2]);
        } else {
            usage();
        }

        if (a.size() + b.size() > kMaxTotalLength)
            throw std::runtime_error("total input length exceeds supported maximum of " +
                                     std::to_string(kMaxTotalLength));

        auto result = sigconv::convolve_exact(a, b);
        const auto& rep = result.report;

        std::cerr << "[proof] coefficient bound: |c_k| <= B = min(n,m)*max|a|*max|b| = "
                  << rep.bound.to_string() << "\n"
                  << "[proof] reconstruction modulus M = product of " << rep.num_primes
                  << " NTT primes = " << rep.modulus.to_string() << "\n"
                  << "[proof] verified M > 2B, so signed CRT reconstruction in (-M/2, M/2] is exact\n"
                  << "[info] n=" << a.size() << " m=" << b.size()
                  << " ntt_size=" << rep.ntt_size << "\n";

        for (size_t i = 0; i < result.coeffs.size(); ++i) {
            if (i) std::cout << ' ';
            std::cout << result.coeffs[i].to_string();
        }
        std::cout << '\n';
    } catch (const std::exception& e) {
        std::cerr << "sigconv: error: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
