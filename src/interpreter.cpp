#include "linker.h"

#include <algorithm>
#include <map>
#include <set>
#include <stack>

namespace lnk {

// Independent oracle: interprets the whole object graph without reusing the
// linker's internals. Resolution rescans all objects per symbol; liveness is
// a depth-first walk over the full graph; relocation expressions are
// evaluated against the caller-supplied layout.
InterpretResult interpret_full_graph(const std::vector<ObjectFile>& objects,
                                     const std::string& entry,
                                     const std::vector<LayoutEntry>& layout) {
    std::map<std::string, std::size_t> chosen_obj;  // symbol -> object index

    // Resolve one symbol by scanning every object in input order.
    auto resolve = [&](const std::string& name) -> const Symbol* {
        const Symbol* weak_pick = nullptr;
        std::size_t weak_obj = 0;
        const Symbol* strong_pick = nullptr;
        std::size_t strong_obj = 0;
        std::size_t strong_count = 0;
        for (std::size_t oi = 0; oi < objects.size(); ++oi) {
            for (const auto& sym : objects[oi].symbols) {
                if (!sym.defined || sym.name != name) continue;
                if (sym.binding == Binding::Strong) {
                    ++strong_count;
                    strong_pick = &sym;
                    strong_obj = oi;
                } else if (weak_pick == nullptr) {
                    weak_pick = &sym;
                    weak_obj = oi;
                }
            }
        }
        if (strong_count > 1)
            throw LinkError("interpreter: multiple strong definitions of " + name);
        if (strong_count == 1) {
            chosen_obj[name] = strong_obj;
            return strong_pick;
        }
        if (weak_pick) {
            chosen_obj[name] = weak_obj;
            return weak_pick;
        }
        return nullptr;
    };

    const Symbol* entry_sym = resolve(entry);
    if (!entry_sym) throw LinkError("interpreter: undefined entry symbol: " + entry);

    // Layout lookup: "object:section_index" -> address.
    std::map<std::pair<std::string, std::size_t>, std::uint64_t> addr_of;
    for (const auto& le : layout) addr_of[{le.object, le.section_index}] = le.address;

    // Depth-first liveness walk over the full graph (explicit stack; the
    // visited set makes circular references terminate).
    std::set<std::pair<std::size_t, std::size_t>> visited;
    std::stack<std::pair<std::size_t, std::size_t>> stack;
    stack.push({chosen_obj[entry], entry_sym->section});
    while (!stack.empty()) {
        auto [oi, si] = stack.top();
        stack.pop();
        if (!visited.insert({oi, si}).second) continue;
        for (const auto& r : objects[oi].sections[si].relocs) {
            const Symbol* target = resolve(r.symbol);
            if (!target)
                throw LinkError("interpreter: undefined symbol " + r.symbol +
                                " referenced from " + objects[oi].name + ":" +
                                objects[oi].sections[si].name);
            stack.push({chosen_obj[r.symbol], target->section});
        }
    }

    InterpretResult result;
    for (const auto& [name, oi] : chosen_obj)
        result.bound_object[name] = objects[oi].name;
    for (const auto& [oi, si] : visited)
        result.live_sections.push_back(objects[oi].name + ":" + objects[oi].sections[si].name);
    std::sort(result.live_sections.begin(), result.live_sections.end());

    // Evaluate every relocation expression in sections present in the layout.
    for (const auto& [oi, si] : visited) {
        auto addr_it = addr_of.find({objects[oi].name, si});
        if (addr_it == addr_of.end()) continue;
        for (const auto& r : objects[oi].sections[si].relocs) {
            const Symbol* target = resolve(r.symbol);
            std::size_t toi = chosen_obj[r.symbol];
            std::uint64_t sym_addr =
                addr_of.at({objects[toi].name, target->section}) + target->value;
            std::uint64_t value = sym_addr + static_cast<std::uint64_t>(r.addend);
            if (r.type == RelocType::Abs32) value &= 0xFFFFFFFFull;
            result.site_values.push_back(
                {objects[oi].name, si, r.offset, r.type, value});
        }
    }

    result.entry_address =
        addr_of.at({objects[chosen_obj[entry]].name, entry_sym->section}) +
        entry_sym->value;
    return result;
}

}  // namespace lnk
