#pragma once

#include "linker.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__,   \
                         #cond);                                           \
            std::exit(1);                                                  \
        }                                                                  \
    } while (0)

inline lnk::Section make_section(std::string name, std::size_t size,
                                 std::size_t align = 1) {
    lnk::Section s;
    s.name = std::move(name);
    s.data.assign(size, 0);
    s.align = align;
    return s;
}

inline void add_reloc(lnk::Section& sec, std::size_t offset, std::string symbol,
                      lnk::RelocType type = lnk::RelocType::Abs64,
                      std::int64_t addend = 0) {
    sec.relocs.push_back({offset, std::move(symbol), type, addend});
}

inline lnk::Symbol defined_sym(std::string name, std::size_t section,
                               std::uint64_t value = 0,
                               lnk::Binding binding = lnk::Binding::Strong) {
    lnk::Symbol s;
    s.name = std::move(name);
    s.binding = binding;
    s.defined = true;
    s.section = section;
    s.value = value;
    return s;
}

inline std::uint64_t read_le(const std::vector<std::uint8_t>& data,
                             std::size_t offset, std::size_t width) {
    std::uint64_t v = 0;
    for (std::size_t i = 0; i < width; ++i)
        v |= static_cast<std::uint64_t>(data[offset + i]) << (8 * i);
    return v;
}

inline const lnk::KeptSection* find_kept(const lnk::LinkResult& res,
                                         const std::string& object,
                                         const std::string& section) {
    for (const auto& k : res.kept_sections)
        if (k.object == object && k.section_name == section) return &k;
    return nullptr;
}

inline const lnk::SymbolBinding* find_binding(const lnk::LinkResult& res,
                                              const std::string& symbol) {
    for (const auto& b : res.bindings)
        if (b.symbol == symbol) return &b;
    return nullptr;
}

// Cross-check the linker output against the whole-graph interpreter oracle.
inline void cross_check(const std::vector<lnk::ObjectFile>& objects,
                        const std::string& entry, const lnk::LinkResult& res) {
    std::vector<lnk::LayoutEntry> layout;
    for (const auto& k : res.kept_sections)
        layout.push_back({k.object, k.section_index, k.address});

    lnk::InterpretResult oracle = lnk::interpret_full_graph(objects, entry, layout);

    // 1. Live sets must agree.
    std::vector<std::string> linker_live;
    for (const auto& k : res.kept_sections)
        linker_live.push_back(k.object + ":" + k.section_name);
    std::sort(linker_live.begin(), linker_live.end());
    CHECK(linker_live == oracle.live_sections);

    // 2. Every symbol the interpreter bound must match the linker's binding.
    for (const auto& [name, obj] : oracle.bound_object) {
        const lnk::SymbolBinding* b = find_binding(res, name);
        CHECK(b != nullptr);
        CHECK(b->defined_in == obj);
    }

    // 3. Every relocation site value must match the linker's relocated bytes.
    for (const auto& site : oracle.site_values) {
        const lnk::KeptSection* kept = nullptr;
        for (const auto& k : res.kept_sections)
            if (k.object == site.object && k.section_index == site.section)
                kept = &k;
        CHECK(kept != nullptr);
        std::size_t width = site.type == lnk::RelocType::Abs32 ? 4 : 8;
        CHECK(read_le(kept->relocated_data, site.offset, width) == site.value);
    }

    // 4. Entry addresses must agree.
    CHECK(res.entry_address == oracle.entry_address);
}
