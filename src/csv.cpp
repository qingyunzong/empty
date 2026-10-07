#include "csv.hpp"

namespace numimport {

Table parse_csv(std::string_view input) {
    Table table;
    Row row;
    std::string field;
    bool in_quotes = false;

    auto end_field = [&] {
        row.push_back(std::move(field));
        field.clear();
    };
    auto end_row = [&] {
        end_field();
        table.push_back(std::move(row));
        row.clear();
    };

    for (std::size_t i = 0; i < input.size(); ++i) {
        const char c = input[i];
        if (in_quotes) {
            if (c == '"') {
                if (i + 1 < input.size() && input[i + 1] == '"') {
                    field.push_back('"');
                    ++i;
                } else {
                    in_quotes = false;
                }
            } else {
                field.push_back(c);
            }
        } else if (c == '"') {
            in_quotes = true;
        } else if (c == ',') {
            end_field();
        } else if (c == '\n') {
            end_row();
        } else if (c == '\r') {
            if (i + 1 < input.size() && input[i + 1] == '\n')
                ++i;
            end_row();
        } else {
            field.push_back(c);
        }
    }
    if (!field.empty() || !row.empty())
        end_row();
    return table;
}

std::string serialize_csv(const Table& table) {
    std::string out;
    for (const Row& row : table) {
        for (std::size_t i = 0; i < row.size(); ++i) {
            if (i != 0)
                out.push_back(',');
            const std::string& field = row[i];
            if (field.find_first_of(",\"\n\r") != std::string::npos) {
                out.push_back('"');
                for (char c : field) {
                    if (c == '"')
                        out.push_back('"');
                    out.push_back(c);
                }
                out.push_back('"');
            } else {
                out += field;
            }
        }
        out.push_back('\n');
    }
    return out;
}

} // namespace numimport
