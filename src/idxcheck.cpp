// idxcheck: CLI validator for idx64 binary index files.
//
// usage: idxcheck [--list] <file>
// exit codes: 0 = valid, 1 = invalid index, 2 = usage/IO error

#include "idx64/index.hpp"

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

namespace {

void usage() {
    std::fprintf(stderr, "usage: idxcheck [--list] <file>\n");
}

} // namespace

int main(int argc, char** argv) {
    bool list = false;
    std::string path;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--list") {
            list = true;
        } else if (arg == "-h" || arg == "--help") {
            usage();
            return 0;
        } else if (!arg.empty() && arg[0] == '-') {
            std::fprintf(stderr, "idxcheck: unknown option '%s'\n", arg.c_str());
            usage();
            return 2;
        } else if (path.empty()) {
            path = arg;
        } else {
            usage();
            return 2;
        }
    }
    if (path.empty()) {
        usage();
        return 2;
    }

    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) {
        std::printf("ERROR: cannot open '%s'\n", path.c_str());
        return 2;
    }
    const auto size = in.tellg();
    in.seekg(0);
    std::vector<std::byte> buf(static_cast<std::size_t>(size));
    if (size > 0)
        in.read(reinterpret_cast<char*>(buf.data()), size);
    if (!in) {
        std::printf("ERROR: failed reading '%s'\n", path.c_str());
        return 2;
    }

    const auto result = idx64::Index::parse(buf);
    if (!result) {
        std::printf("INVALID: %s\n", std::string(idx64::to_string(result.error())).c_str());
        return 1;
    }

    std::printf("OK: %zu segment(s), file %zu bytes\n",
                result->segments().size(), buf.size());
    if (list) {
        std::size_t i = 0;
        for (const auto& s : result->segments()) {
            const auto view = result->segment_view(buf, i);
            std::printf("  [%zu] offset=%llu length=%llu end=%llu view=%s\n", i,
                        static_cast<unsigned long long>(s.offset),
                        static_cast<unsigned long long>(s.length),
                        static_cast<unsigned long long>(s.offset + s.length),
                        view ? "in-bounds" : "OUT-OF-BOUNDS");
            ++i;
        }
    }
    return 0;
}
