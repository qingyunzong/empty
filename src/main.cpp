#include "column.hpp"
#include "csv.hpp"
#include "numparse.hpp"

#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>

namespace {

int usage() {
    std::cerr << "usage: numimport [--header] [file|-]\n"
                 "Reads CSV (stdin when no file or '-' is given), picks '.' or ',' as\n"
                 "the decimal separator per column by examining every row, and writes\n"
                 "CSV with numbers rendered as exact fractions. Empty cells stay empty.\n"
                 "--header treats the first row as a header and passes it through.\n";
    return 2;
}

} // namespace

int main(int argc, char** argv) {
    bool has_header = false;
    const char* path = nullptr;
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "--header")
            has_header = true;
        else if (path == nullptr)
            path = argv[i];
        else
            return usage();
    }
    std::string input;
    if (path == nullptr || std::string_view(path) == "-") {
        input.assign(std::istreambuf_iterator<char>(std::cin),
                     std::istreambuf_iterator<char>());
    } else {
        std::ifstream in(path, std::ios::binary);
        if (!in) {
            std::cerr << "numimport: error: cannot open '" << path << "'\n";
            return 2;
        }
        std::ostringstream ss;
        ss << in.rdbuf();
        input = ss.str();
    }

    numimport::Table table = numimport::parse_csv(input);

    std::size_t columns = 0;
    for (const auto& row : table)
        columns = std::max(columns, row.size());

    std::vector<numimport::ColumnDecision> decisions;
    decisions.reserve(columns);
    const std::size_t first_data_row = has_header && !table.empty() ? 1 : 0;
    for (std::size_t c = 0; c < columns; ++c) {
        std::vector<std::string> cells;
        cells.reserve(table.size());
        for (std::size_t r = first_data_row; r < table.size(); ++r)
            cells.push_back(c < table[r].size() ? table[r][c] : "");
        numimport::ColumnDecision d = numimport::decide_column(cells);
        if (d.error == numimport::ColumnError::ambiguous) {
            std::cerr << "numimport: error: column " << (c + 1)
                      << " is ambiguous: '.' and ',' are both valid decimal separators"
                         " but give different values (row "
                      << (d.error_row + first_data_row) << ": \"" << d.error_cell
                      << "\")\n";
            return 1;
        }
        if (d.error == numimport::ColumnError::inconsistent) {
            std::cerr << "numimport: error: column " << (c + 1)
                      << " has no consistent decimal separator (row "
                      << (d.error_row + first_data_row) << ": \"" << d.error_cell
                      << "\")\n";
            return 1;
        }
        decisions.push_back(std::move(d));
    }

    for (std::size_t r = first_data_row; r < table.size(); ++r) {
        auto& row = table[r];
        for (std::size_t c = 0; c < row.size(); ++c) {
            const auto& d = decisions[c];
            if (d.kind != numimport::ColumnKind::numeric)
                continue;
            const std::string_view cell = numimport::trim(row[c]);
            if (cell.empty()) {
                row[c].clear(); // empty values are preserved as empty
                continue;
            }
            row[c] = numimport::parse_number(cell, d.sep)->to_string();
        }
    }

    std::cout << numimport::serialize_csv(table);
    return 0;
}
