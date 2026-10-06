#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace lnk {

enum class Binding { Strong, Weak };

enum class RelocType { Abs32, Abs64 };

struct Relocation {
    std::size_t offset = 0;   // byte offset within the section data
    std::string symbol;       // referenced symbol name
    RelocType type = RelocType::Abs64;
    std::int64_t addend = 0;
};

struct Section {
    std::string name;
    std::vector<std::uint8_t> data;
    std::vector<Relocation> relocs;
    std::size_t align = 1;
};

struct Symbol {
    std::string name;
    Binding binding = Binding::Strong;
    bool defined = false;
    std::size_t section = 0;  // index into ObjectFile::sections, valid when defined
    std::uint64_t value = 0;  // byte offset within that section
};

struct ObjectFile {
    std::string name;
    std::vector<Section> sections;
    std::vector<Symbol> symbols;
};

struct LinkError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

// Evidence that one undefined reference was bound to one definition.
struct SymbolBinding {
    std::string symbol;
    std::string defined_in;    // object file name
    std::size_t section = 0;   // section index inside that object
    std::uint64_t value = 0;   // offset within the section
    Binding binding = Binding::Strong;
    std::string reason;        // why this definition won
};

struct KeptSection {
    std::string object;
    std::size_t section_index = 0;
    std::string section_name;
    std::uint64_t address = 0;
    std::vector<std::uint8_t> relocated_data;
    std::string reason;        // reachability evidence
};

struct LinkResult {
    std::string entry_symbol;
    std::uint64_t entry_address = 0;
    std::vector<SymbolBinding> bindings;     // sorted by symbol name
    std::vector<KeptSection> kept_sections;  // in layout order
    std::vector<std::string> gc_sections;    // "object:section" dropped by GC
};

class Linker {
public:
    // Links objects (in input order) rooted at the entry symbol.
    // Throws LinkError on strong-definition conflicts, undefined entry,
    // undefined references from kept sections, or relocation overflow.
    LinkResult link(const std::vector<ObjectFile>& objects,
                    const std::string& entry,
                    std::uint64_t base_address = 0x1000) const;
};

// ---- Whole-graph interpreter (independent oracle) ----
// Resolves symbols and walks the full object graph with its own
// implementation, then evaluates every relocation expression against a
// caller-supplied layout. Used to cross-check the Linker.

struct LayoutEntry {
    std::string object;
    std::size_t section_index = 0;
    std::uint64_t address = 0;
};

struct SiteValue {
    std::string object;
    std::size_t section = 0;
    std::size_t offset = 0;
    RelocType type = RelocType::Abs64;
    std::uint64_t value = 0;   // evaluated symbol_address + addend, truncated to width
};

struct InterpretResult {
    std::unordered_map<std::string, std::string> bound_object;  // symbol -> defining object
    std::vector<std::string> live_sections;                     // "object:section", sorted
    std::vector<SiteValue> site_values;                         // for sections present in layout
    std::uint64_t entry_address = 0;
};

InterpretResult interpret_full_graph(const std::vector<ObjectFile>& objects,
                                     const std::string& entry,
                                     const std::vector<LayoutEntry>& layout);

}  // namespace lnk
