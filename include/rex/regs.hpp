#pragma once

#include "value.hpp"

#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace rex {

// Static declaration of a register: a name and a width in [8, 64].
struct RegDecl {
  std::string name;
  uint8_t width;
};

// Runtime register file. A declared register that has not been written
// holds no value; reading it is a runtime error.
struct RegFile {
  std::vector<std::string> names;
  std::vector<uint8_t> widths;
  std::vector<std::optional<uint64_t>> values; // masked to widths[i]

  static RegFile from_decls(const std::vector<RegDecl>& decls) {
    RegFile rf;
    for (const auto& d : decls) {
      rf.names.push_back(d.name);
      rf.widths.push_back(d.width);
      rf.values.push_back(std::nullopt);
    }
    return rf;
  }

  uint32_t index_of(std::string_view name) const {
    for (uint32_t i = 0; i < names.size(); ++i)
      if (names[i] == name)
        return i;
    throw std::invalid_argument("unknown register: " + std::string(name));
  }

  void write(uint32_t idx, uint64_t v) {
    values.at(idx) = v & mask_for(widths.at(idx));
  }

  void write(std::string_view name, uint64_t v) { write(index_of(name), v); }

  void clear() {
    for (auto& v : values)
      v.reset();
  }
};

} // namespace rex
