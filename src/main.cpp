// convolve: exact convolution of two signed 64-bit integer sequences.
//
// Usage: convolve <file1> <file2>
//   Each file contains whitespace-separated signed 64-bit integers.
//   Use "-" to read a sequence from standard input (at most once).
// Output: n + m - 1 lines, the exact decimal convolution coefficients.

#include <charconv>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "convolution.hpp"

namespace {

std::vector<int64_t> read_sequence(std::istream& in, const char* name) {
    std::vector<int64_t> out;
    std::string tok;
    while (in >> tok) {
        int64_t v = 0;
        const char* first = tok.data();
        const char* last = first + tok.size();
        auto [ptr, ec] = std::from_chars(first, last, v);
        if (ec != std::errc{} || ptr != last) {
            std::fprintf(stderr, "convolve: %s: invalid int64 token '%s'\n", name,
                         tok.c_str());
            std::exit(1);
        }
        out.push_back(v);
    }
    if (in.bad()) {
        std::fprintf(stderr, "convolve: %s: read error\n", name);
        std::exit(1);
    }
    return out;
}

std::vector<int64_t> read_file(const std::string& path) {
    if (path == "-") return read_sequence(std::cin, "<stdin>");
    std::ifstream f(path);
    if (!f) {
        std::fprintf(stderr, "convolve: cannot open '%s'\n", path.c_str());
        std::exit(1);
    }
    return read_sequence(f, path.c_str());
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: %s <file1> <file2>   ('-' reads stdin)\n",
                     argv[0]);
        return 2;
    }
    std::vector<int64_t> a = read_file(argv[1]);
    std::vector<int64_t> b = read_file(argv[2]);

    std::vector<conv::BigInt> c;
    try {
        c = conv::convolution(a, b);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "convolve: %s\n", e.what());
        return 1;
    }

    std::string out;
    for (const auto& v : c) {
        out += v.to_string();
        out += '\n';
    }
    std::fwrite(out.data(), 1, out.size(), stdout);
    return 0;
}
