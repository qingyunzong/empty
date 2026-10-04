#include "lt/interp.hpp"
#include "lt/link.hpp"
#include "lt/parse.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

void usage(const char* argv0) {
    std::cerr << "usage: " << argv0
              << " [--entry SYM] [--base ADDR] [--no-gc] [--check]"
                 " [-o OUT] OBJ...\n";
}

} // namespace

int main(int argc, char** argv) {
    lt::LinkOptions opts;
    std::string out_path;
    bool check = false;
    std::vector<std::string> inputs;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        auto need = [&](const char* what) -> std::string {
            if (++i >= argc) {
                std::cerr << "missing value for " << what << "\n";
                std::exit(2);
            }
            return argv[i];
        };
        if (arg == "--entry")
            opts.entry = need("--entry");
        else if (arg == "--base")
            opts.base = std::stoull(need("--base"), nullptr, 0);
        else if (arg == "--no-gc")
            opts.gc = false;
        else if (arg == "--check")
            check = true;
        else if (arg == "-o")
            out_path = need("-o");
        else if (arg == "--help") {
            usage(argv[0]);
            return 0;
        } else
            inputs.push_back(arg);
    }
    if (inputs.empty()) {
        usage(argv[0]);
        return 2;
    }
    try {
        std::vector<lt::Object> objects;
        for (const auto& path : inputs)
            objects.push_back(lt::parse_object_file(path));
        lt::LinkResult result = lt::link(std::move(objects), opts);
        std::cout << lt::format_evidence(result);
        if (check) {
            auto errors = lt::interpret_check(result, opts);
            if (!errors.empty()) {
                std::cerr << "interpreter cross-check FAILED:\n";
                for (const auto& e : errors)
                    std::cerr << "  " << e << "\n";
                return 1;
            }
            std::cout << "interpreter cross-check: OK\n";
        }
        if (!out_path.empty()) {
            std::ofstream out(out_path, std::ios::binary);
            for (const auto& sec : result.output) {
                out << "# " << sec.name << " @ 0x" << std::hex << sec.addr
                    << "\n";
                out.write(reinterpret_cast<const char*>(sec.data.data()),
                          static_cast<std::streamsize>(sec.data.size()));
            }
        }
    } catch (const std::exception& e) {
        std::cerr << "ltlink: error: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
