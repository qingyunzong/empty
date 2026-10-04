#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace lt {

enum class Binding { Strong, Weak };

enum class RelocKind { Abs32, Abs64, Pc32 };

struct Reloc {
    RelocKind kind = RelocKind::Abs64;
    std::size_t offset = 0;   // byte offset within the section
    std::string symbol;       // referenced symbol
    std::int64_t addend = 0;
};

struct Section {
    std::string name;
    std::size_t align = 1;
    std::vector<std::uint8_t> data; // data.size() is the section size
    std::vector<Reloc> relocs;
    bool keep = false;              // explicit GC root

    // filled in by the linker
    bool reachable = false;
    std::uint64_t addr = 0;
};

struct Symbol {
    std::string name;
    Binding binding = Binding::Strong;
    bool defined = false;
    std::string section;            // defining section (valid when defined)
    std::uint64_t value = 0;        // offset within the defining section
};

struct Object {
    std::string name;
    std::vector<Section> sections;
    std::vector<Symbol> symbols;
};

} // namespace lt
