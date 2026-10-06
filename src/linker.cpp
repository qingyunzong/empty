#include "linker.h"

#include <algorithm>
#include <deque>
#include <map>
#include <set>
#include <sstream>
#include <utility>

namespace lnk {
namespace {

using SectionId = std::pair<std::size_t, std::size_t>;  // (object index, section index)

struct Definition {
    std::size_t object;
    const Symbol* sym;
};

std::string section_key(std::size_t obj, const ObjectFile& o, std::size_t sec) {
    return o.name + ":" + o.sections[sec].name;
}

std::uint64_t align_up(std::uint64_t v, std::size_t align) {
    if (align <= 1) return v;
    std::uint64_t a = align;
    return (v + a - 1) / a * a;
}

}  // namespace

LinkResult Linker::link(const std::vector<ObjectFile>& objects,
                        const std::string& entry,
                        std::uint64_t base_address) const {
    // ---- 1. Symbol resolution -------------------------------------------
    // Collect definitions per symbol name in object input order.
    std::map<std::string, std::vector<Definition>> defs;
    for (std::size_t oi = 0; oi < objects.size(); ++oi) {
        for (const auto& sym : objects[oi].symbols) {
            if (!sym.defined) continue;
            if (sym.section >= objects[oi].sections.size())
                throw LinkError("symbol " + sym.name + " in " + objects[oi].name +
                                " refers to out-of-range section");
            defs[sym.name].push_back({oi, &sym});
        }
    }

    std::map<std::string, Definition> chosen;
    std::map<std::string, std::string> reasons;
    for (const auto& [name, candidates] : defs) {
        std::vector<Definition> strongs;
        for (const auto& d : candidates)
            if (d.sym->binding == Binding::Strong) strongs.push_back(d);

        if (strongs.size() > 1) {
            std::ostringstream oss;
            oss << "multiple strong definitions of symbol " << name << " (";
            for (std::size_t i = 0; i < strongs.size(); ++i) {
                if (i) oss << ", ";
                oss << objects[strongs[i].object].name;
            }
            oss << ")";
            throw LinkError(oss.str());
        }

        if (strongs.size() == 1) {
            chosen[name] = strongs[0];
            std::size_t weak_count = candidates.size() - 1;
            reasons[name] = weak_count == 0
                ? "unique strong definition"
                : "strong definition overrides " + std::to_string(weak_count) + " weak";
        } else {
            // Weak-only: first definition in object input order wins.
            chosen[name] = candidates.front();
            reasons[name] = "first weak definition in input order (of " +
                            std::to_string(candidates.size()) + ")";
        }
    }

    auto entry_it = chosen.find(entry);
    if (entry_it == chosen.end())
        throw LinkError("undefined entry symbol: " + entry);

    // ---- 2. Liveness sweep from the entry section ------------------------
    // Breadth-first walk over section references; a visited set makes
    // circular references terminate.
    std::set<SectionId> live;
    std::map<SectionId, std::string> live_reason;
    std::deque<SectionId> worklist;

    const Definition& entry_def = entry_it->second;
    SectionId entry_sec{entry_def.object, entry_def.sym->section};
    worklist.push_back(entry_sec);
    live_reason[entry_sec] = "entry section (symbol " + entry + ")";

    while (!worklist.empty()) {
        SectionId cur = worklist.front();
        worklist.pop_front();
        if (!live.insert(cur).second) continue;
        const auto& sec = objects[cur.first].sections[cur.second];
        for (const auto& r : sec.relocs) {
            auto it = chosen.find(r.symbol);
            if (it == chosen.end()) {
                throw LinkError("undefined symbol " + r.symbol + " referenced from " +
                                section_key(cur.first, objects[cur.first], cur.second));
            }
            SectionId next{it->second.object, it->second.sym->section};
            if (live_reason.find(next) == live_reason.end()) {
                live_reason[next] = "referenced by " +
                                    section_key(cur.first, objects[cur.first], cur.second) +
                                    " via symbol " + r.symbol;
            }
            worklist.push_back(next);
        }
    }

    // ---- 3. Layout: assign addresses to kept sections --------------------
    std::map<SectionId, std::uint64_t> address;
    std::uint64_t cursor = base_address;
    for (std::size_t oi = 0; oi < objects.size(); ++oi) {
        for (std::size_t si = 0; si < objects[oi].sections.size(); ++si) {
            SectionId id{oi, si};
            if (!live.count(id)) continue;
            cursor = align_up(cursor, objects[oi].sections[si].align);
            address[id] = cursor;
            cursor += objects[oi].sections[si].data.size();
        }
    }

    auto symbol_address = [&](const Definition& d) {
        return address.at({d.object, d.sym->section}) + d.sym->value;
    };

    // ---- 4. Relocation ----------------------------------------------------
    LinkResult result;
    result.entry_symbol = entry;
    result.entry_address = symbol_address(entry_def);

    for (const auto& [id, addr] : address) {
        const auto& obj = objects[id.first];
        const auto& sec = obj.sections[id.second];
        KeptSection kept;
        kept.object = obj.name;
        kept.section_index = id.second;
        kept.section_name = sec.name;
        kept.address = addr;
        kept.reason = live_reason[id];
        kept.relocated_data = sec.data;
        for (const auto& r : sec.relocs) {
            std::uint64_t value = symbol_address(chosen.at(r.symbol)) + r.addend;
            std::size_t width = r.type == RelocType::Abs32 ? 4 : 8;
            if (r.offset + width > kept.relocated_data.size())
                throw LinkError("relocation out of range in " +
                                section_key(id.first, obj, id.second));
            if (r.type == RelocType::Abs32 && value > 0xFFFFFFFFull)
                throw LinkError("relocation overflow (Abs32) for symbol " + r.symbol +
                                " in " + section_key(id.first, obj, id.second));
            for (std::size_t i = 0; i < width; ++i)
                kept.relocated_data[r.offset + i] =
                    static_cast<std::uint8_t>((value >> (8 * i)) & 0xFF);
        }
        result.kept_sections.push_back(std::move(kept));
    }

    // ---- 5. Evidence -------------------------------------------------------
    for (const auto& [name, def] : chosen) {
        SymbolBinding b;
        b.symbol = name;
        b.defined_in = objects[def.object].name;
        b.section = def.sym->section;
        b.value = def.sym->value;
        b.binding = def.sym->binding;
        b.reason = reasons[name];
        result.bindings.push_back(std::move(b));
    }

    for (std::size_t oi = 0; oi < objects.size(); ++oi)
        for (std::size_t si = 0; si < objects[oi].sections.size(); ++si)
            if (!live.count({oi, si}))
                result.gc_sections.push_back(section_key(oi, objects[oi], si));

    return result;
}

}  // namespace lnk
