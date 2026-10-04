#pragma once

#include "lt/model.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace lt {

struct BindingEvidence {
    std::string symbol;
    std::string referrer; // "obj:section+off", "<entry>", or "<keep:...>"
    std::string chosen;   // "obj:section+value" or "<null>" (weak undef -> 0)
    std::string reason;   // why this definition was chosen
};

struct OutputSection {
    std::string name;
    std::uint64_t addr = 0;
    std::vector<std::uint8_t> data; // relocated bytes of all kept members
};

struct LinkResult {
    std::vector<Object> objects;          // reachability + addresses filled in
    std::vector<OutputSection> output;    // linked image, grouped by section name
    std::vector<BindingEvidence> evidence;
    std::uint64_t entry_addr = 0;
};

struct LinkOptions {
    std::string entry = "entry";   // entry symbol name
    std::uint64_t base = 0x1000;   // base address of the image
    bool gc = true;                // garbage-collect unreachable sections
};

// Throws std::runtime_error on strong-definition conflicts or unresolved
// strong undefined symbols.
LinkResult link(std::vector<Object> objects, const LinkOptions& opts);

std::string format_evidence(const LinkResult& result);

} // namespace lt
