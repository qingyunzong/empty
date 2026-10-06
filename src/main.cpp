#include "column_format.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

using numimport::ColumnDecision;
using numimport::ColumnStatus;
using numimport::convertCell;
using numimport::decideColumn;

void usage(std::ostream& os) {
    os << "usage: numimport [--delimiter C] [input file]\n"
          "Reads delimiter-separated numbers (default delimiter ';', stdin when no\n"
          "file is given), picks '.' or ',' as the decimal separator for each whole\n"
          "column, and prints every number as an exact fraction. Empty cells are\n"
          "preserved. Fails when a column is ambiguous or has no consistent format.\n";
}

std::vector<std::string> splitRow(const std::string& line, char delimiter) {
    std::vector<std::string> cells;
    size_t begin = 0;
    for (;;) {
        const size_t pos = line.find(delimiter, begin);
        if (pos == std::string::npos) {
            cells.push_back(line.substr(begin));
            return cells;
        }
        cells.push_back(line.substr(begin, pos - begin));
        begin = pos + 1;
    }
}

} // namespace

int main(int argc, char** argv) {
    char delimiter = ';';
    std::string path;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--delimiter" && i + 1 < argc) {
            const std::string d = argv[++i];
            if (d.size() != 1) {
                std::cerr << "error: --delimiter expects a single character\n";
                return 2;
            }
            delimiter = d[0];
        } else if (arg == "--help") {
            usage(std::cout);
            return 0;
        } else if (!arg.empty() && arg[0] == '-') {
            std::cerr << "error: unknown option " << arg << '\n';
            usage(std::cerr);
            return 2;
        } else if (path.empty()) {
            path = arg;
        } else {
            std::cerr << "error: unexpected argument " << arg << '\n';
            return 2;
        }
    }

    std::ifstream file;
    std::istream* in = &std::cin;
    if (!path.empty()) {
        file.open(path);
        if (!file) {
            std::cerr << "error: cannot open " << path << '\n';
            return 2;
        }
        in = &file;
    }

    std::vector<std::vector<std::string>> rows;
    size_t columnCount = 0;
    std::string line;
    while (std::getline(*in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        rows.push_back(splitRow(line, delimiter));
        columnCount = std::max(columnCount, rows.back().size());
    }
    for (auto& row : rows) row.resize(columnCount); // short rows: missing cells are empty

    std::vector<char> decimals(columnCount, '.');
    for (size_t c = 0; c < columnCount; ++c) {
        std::vector<std::string> cells;
        cells.reserve(rows.size());
        for (const auto& row : rows) cells.push_back(row[c]);
        const ColumnDecision decision = decideColumn(cells);
        if (decision.status == ColumnStatus::Ambiguous) {
            std::cerr << "error: column " << (c + 1) << " is ambiguous: both '.' and ',' work as\n"
                         "decimal separator but give different values, first at row "
                      << (decision.problemRow + 1) << ": \"" << decision.problemToken << "\"\n";
            return 1;
        }
        if (decision.status == ColumnStatus::Invalid) {
            std::cerr << "error: column " << (c + 1) << " has no consistent number format, first\n"
                         "unparseable value at row "
                      << (decision.problemRow + 1) << ": \"" << decision.problemToken << "\"\n";
            return 1;
        }
        decimals[c] = decision.decimalChar;
        std::cerr << "column " << (c + 1) << ": decimal separator '" << decimals[c] << "'\n";
    }

    for (const auto& row : rows) {
        for (size_t c = 0; c < columnCount; ++c) {
            if (c > 0) std::cout << delimiter;
            std::cout << convertCell(row[c], decimals[c]);
        }
        std::cout << '\n';
    }
    return 0;
}
