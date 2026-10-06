#include <fstream>
#include <iostream>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

#include "column.hpp"

namespace {

std::vector<uint8_t> read_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw col::ColumnError("cannot open " + path);
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

void write_file(const std::string& path, const std::vector<uint8_t>& bytes) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out) throw col::ColumnError("cannot write " + path);
  out.write(reinterpret_cast<const char*>(bytes.data()),
            static_cast<std::streamsize>(bytes.size()));
  if (!out) throw col::ColumnError("failed writing " + path);
}

std::vector<std::optional<int64_t>> parse_text(const std::string& path) {
  std::ifstream in(path);
  if (!in) throw col::ColumnError("cannot open " + path);
  std::vector<std::optional<int64_t>> rows;
  std::string line;
  uint64_t lineno = 0;
  while (std::getline(in, line)) {
    ++lineno;
    size_t b = line.find_first_not_of(" \t\r");
    if (b == std::string::npos) continue;
    size_t e = line.find_last_not_of(" \t\r");
    std::string tok = line.substr(b, e - b + 1);
    if (tok == "null" || tok == "NULL") {
      rows.push_back(std::nullopt);
      continue;
    }
    try {
      size_t used = 0;
      long long v = std::stoll(tok, &used);
      if (used != tok.size()) throw std::invalid_argument("junk");
      rows.push_back(static_cast<int64_t>(v));
    } catch (const std::exception&) {
      throw col::ColumnError("bad integer at " + path + ":" + std::to_string(lineno));
    }
  }
  return rows;
}

int usage() {
  std::cerr << "usage:\n"
            << "  colcli build <input.txt> <output.col> [block_rows]\n"
            << "  colcli agg <file.col>\n"
            << "  colcli filter <file.col> <eq|ne|lt|le|gt|ge> <value>\n";
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc >= 4 && std::string(argv[1]) == "build") {
      uint64_t block_rows = 4096;
      if (argc >= 5) block_rows = std::stoull(argv[4]);
      auto rows = parse_text(argv[2]);
      auto bytes = col::encode_column(rows, block_rows);
      write_file(argv[3], bytes);
      std::cout << "wrote " << rows.size() << " rows\n";
      return 0;
    }
    if (argc == 3 && std::string(argv[1]) == "agg") {
      auto bytes = read_file(argv[2]);
      col::AggResult r = col::aggregate(bytes.data(), bytes.size());
      // Results are printed only after every block validated and scanned.
      std::cout << "rows=" << r.rows << " non_null=" << r.non_null
                << " sum=" << col::to_string_i128(r.sum) << "\n";
      return 0;
    }
    if (argc == 5 && std::string(argv[1]) == "filter") {
      col::CmpOp op;
      if (!col::parse_op(argv[3], op)) {
        std::cerr << "unknown operator: " << argv[3] << "\n";
        return 2;
      }
      int64_t rhs = 0;
      try {
        size_t used = 0;
        std::string s = argv[4];
        long long v = std::stoll(s, &used);
        if (used != s.size()) throw std::invalid_argument("junk");
        rhs = static_cast<int64_t>(v);
      } catch (const std::exception&) {
        std::cerr << "bad comparison value: " << argv[4] << "\n";
        return 2;
      }
      auto bytes = read_file(argv[2]);
      // Fully computed (or ColumnError) before anything is printed.
      std::vector<uint64_t> pos =
          col::filter_positions(bytes.data(), bytes.size(), op, rhs);
      for (uint64_t p : pos) std::cout << p << "\n";
      return 0;
    }
    return usage();
  } catch (const std::exception& e) {
    std::cerr << "error: " << e.what() << "\n";
    return 1;
  }
}
