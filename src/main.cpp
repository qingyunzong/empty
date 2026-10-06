#include "columnar/blocks.hpp"

#include <fstream>
#include <iostream>

using namespace columnar;

namespace {

void usage() {
    std::cerr <<
        "usage:\n"
        "  colcli write  <file> <rows> [seed]   generate a random column file\n"
        "  colcli filter <file> <op> <value>    print matching original row numbers\n"
        "  colcli agg    <file>                 rows=<total incl nulls> sum=<non-null>\n"
        "  colcli agg    <file> <op> <value>    count/sum over matching rows\n"
        "ops: = != < <= > >=\n";
}

Column load(const char* path) {
    std::ifstream in(path, std::ios::binary);
    if (!in)
        throw Error(std::string("cannot open ") + path);
    return read_column(in); // validates everything before returning
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        usage();
        return 2;
    }
    const std::string cmd = argv[1];
    try {
        if (cmd == "write" && (argc == 4 || argc == 5)) {
            uint64_t rows = std::stoull(argv[3]);
            uint64_t seed = argc == 5 ? std::stoull(argv[4]) : 42;
            Column col = generate_column(rows, seed);
            std::ofstream out(argv[2], std::ios::binary | std::ios::trunc);
            if (!out)
                throw Error(std::string("cannot open ") + argv[2]);
            write_column(out, col);
            out.flush();
            if (!out)
                throw Error("write failed");
            std::cout << "wrote rows=" << col.num_rows
                      << " blocks=" << col.blocks.size() << "\n";
            return 0;
        }
        if (cmd == "filter" && argc == 5) {
            Column col = load(argv[2]);
            CmpOp op = parse_op(argv[3]);
            int64_t v = std::stoll(argv[4]);
            for (uint64_t pos : filter_positions(col, op, v))
                std::cout << pos << "\n";
            return 0;
        }
        if (cmd == "agg" && (argc == 3 || argc == 5)) {
            Column col = load(argv[2]);
            if (argc == 3) {
                AggResult r = aggregate(col);
                std::cout << "rows=" << r.count << " sum=" << to_string_i128(r.sum) << "\n";
            } else {
                CmpOp op = parse_op(argv[3]);
                int64_t v = std::stoll(argv[4]);
                AggResult r = aggregate(col, op, v);
                std::cout << "count=" << r.count << " sum=" << to_string_i128(r.sum) << "\n";
            }
            return 0;
        }
        usage();
        return 2;
    } catch (const std::exception& e) {
        // Any failure (corrupt block, bad args, IO) aborts before output.
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
}
