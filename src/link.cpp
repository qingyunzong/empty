#include "lt/link.hpp"

#include <algorithm>
#include <deque>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace lt {

namespace {

struct Def {
    std::size_t obj = 0;
    std::size_t sym = 0;
    bool weak = false;
};

// Global symbol table built by scanning objects in input order.
struct Symtab {
    std::map<std::string, Def> defs;             // chosen definition per name
    std::map<std::string, std::string> reasons;  // why that definition won
    std::set<std::string> weak_undefs;           // names declared weak-undef
};

Symtab resolve(const std::vector<Object>& objects) {
    Symtab tab;
    for (std::size_t oi = 0; oi < objects.size(); ++oi) {
        const auto& obj = objects[oi];
        for (std::size_t si = 0; si < obj.symbols.size(); ++si) {
            const auto& sym = obj.symbols[si];
            if (!sym.defined) {
                if (sym.binding == Binding::Weak)
                    tab.weak_undefs.insert(sym.name);
                continue;
            }
            bool weak = sym.binding == Binding::Weak;
            auto it = tab.defs.find(sym.name);
            if (it == tab.defs.end()) {
                tab.defs.emplace(sym.name, Def{oi, si, weak});
                tab.reasons.emplace(sym.name,
                                    weak ? "weak definition (first in input order)"
                                         : "strong definition");
                continue;
            }
            Def& cur = it->second;
            const auto& cur_sym = objects[cur.obj].symbols[cur.sym];
            if (!cur.weak && !weak) {
                throw std::runtime_error(
                    "strong definition conflict for '" + sym.name + "': " +
                    objects[cur.obj].name + ":" + cur_sym.section + " vs " +
                    obj.name + ":" + sym.section);
            }
            if (cur.weak && !weak) {
                cur = Def{oi, si, weak};
                tab.reasons[sym.name] = "strong definition overrides weak";
            }
            // weak vs weak: first in input order wins; strong vs weak: strong
            // already present wins. Either way, keep the current entry.
        }
    }
    return tab;
}

struct SymLoc {
    std::size_t obj = 0;
    std::size_t sec = 0;
    std::uint64_t value = 0; // offset within section
};

// Looks up the section index of a symbol's definition within its object.
SymLoc locate(const std::vector<Object>& objects, const Def& def) {
    const auto& sym = objects[def.obj].symbols[def.sym];
    const auto& secs = objects[def.obj].sections;
    for (std::size_t i = 0; i < secs.size(); ++i)
        if (secs[i].name == sym.section)
            return SymLoc{def.obj, i, sym.value};
    throw std::runtime_error("symbol '" + sym.name + "' refers to missing "
                             "section '" + sym.section + "'");
}

std::string describe(const std::vector<Object>& objects, const Def& def) {
    const auto& sym = objects[def.obj].symbols[def.sym];
    return objects[def.obj].name + ":" + sym.section + "+0x" +
           ([&] { std::ostringstream os; os << std::hex << sym.value;
                  return os.str(); })();
}

void put(std::uint8_t* dst, std::uint64_t value, std::size_t width) {
    for (std::size_t i = 0; i < width; ++i)
        dst[i] = static_cast<std::uint8_t>(value >> (8 * i));
}

} // namespace

LinkResult link(std::vector<Object> objects, const LinkOptions& opts) {
    Symtab tab = resolve(objects);

    auto entry_it = tab.defs.find(opts.entry);
    if (entry_it == tab.defs.end())
        throw std::runtime_error("entry symbol '" + opts.entry +
                                 "' is not defined");

    LinkResult result;
    // Roots: the entry symbol's section plus every section flagged keep.
    std::deque<SymLoc> worklist;
    auto enqueue = [&](const SymLoc& loc) {
        auto& sec = objects[loc.obj].sections[loc.sec];
        if (!sec.reachable) {
            sec.reachable = true;
            worklist.push_back(loc);
        }
    };
    enqueue(locate(objects, entry_it->second));
    result.evidence.push_back(BindingEvidence{
        opts.entry, "<entry>", describe(objects, entry_it->second),
        tab.reasons[opts.entry]});
    for (std::size_t oi = 0; oi < objects.size(); ++oi)
        for (std::size_t si = 0; si < objects[oi].sections.size(); ++si)
            if (objects[oi].sections[si].keep)
                enqueue(SymLoc{oi, si, 0});

    // Reachability: follow relocations. A visited set makes cycles legal.
    while (!worklist.empty()) {
        SymLoc loc = worklist.front();
        worklist.pop_front();
        const auto& sec = objects[loc.obj].sections[loc.sec];
        std::string referrer = objects[loc.obj].name + ":" + sec.name;
        for (const auto& rel : sec.relocs) {
            auto it = tab.defs.find(rel.symbol);
            if (it == tab.defs.end()) {
                if (tab.weak_undefs.count(rel.symbol)) {
                    result.evidence.push_back(BindingEvidence{
                        rel.symbol, referrer, "<null>",
                        "weak undefined symbol resolves to 0"});
                    continue;
                }
                throw std::runtime_error("unresolved symbol '" + rel.symbol +
                                         "' referenced from " + referrer);
            }
            result.evidence.push_back(BindingEvidence{
                rel.symbol, referrer, describe(objects, it->second),
                tab.reasons[rel.symbol]});
            enqueue(locate(objects, it->second));
        }
    }

    if (!opts.gc)
        for (std::size_t oi = 0; oi < objects.size(); ++oi)
            for (auto& sec : objects[oi].sections)
                sec.reachable = true;

    // Layout: group kept sections by name, first-appearance order, honoring
    // alignment; addresses are unique across the whole image.
    std::map<std::string, std::size_t> group_of;
    std::vector<std::string> group_order;
    for (const auto& obj : objects)
        for (const auto& sec : obj.sections)
            if (sec.reachable && !group_of.count(sec.name)) {
                group_of[sec.name] = group_order.size();
                group_order.push_back(sec.name);
            }
    std::vector<std::uint64_t> cursor(group_order.size(), 0);
    std::vector<std::uint64_t> group_addr(group_order.size(), 0);
    {
        std::uint64_t next = opts.base;
        for (std::size_t gi = 0; gi < group_order.size(); ++gi) {
            std::size_t align = 1;
            for (const auto& obj : objects)
                for (const auto& sec : obj.sections)
                    if (sec.reachable && sec.name == group_order[gi])
                        align = std::max(align, sec.align);
            next = (next + align - 1) / align * align;
            group_addr[gi] = next;
            cursor[gi] = next;
            for (auto& obj : objects)
                for (auto& sec : obj.sections)
                    if (sec.reachable && sec.name == group_order[gi]) {
                        cursor[gi] =
                            (cursor[gi] + sec.align - 1) / sec.align * sec.align;
                        sec.addr = cursor[gi];
                        cursor[gi] += sec.data.size();
                    }
            next = cursor[gi];
        }
    }

    // Relocation: patch kept sections in place, then concatenate per group.
    for (auto& obj : objects) {
        for (auto& sec : obj.sections) {
            if (!sec.reachable)
                continue;
            for (const auto& rel : sec.relocs) {
                std::uint64_t sym_addr = 0;
                auto it = tab.defs.find(rel.symbol);
                if (it != tab.defs.end()) {
                    SymLoc loc = locate(objects, it->second);
                    sym_addr =
                        objects[loc.obj].sections[loc.sec].addr + loc.value;
                } // weak undefined: sym_addr stays 0
                std::uint64_t place = sec.addr + rel.offset;
                std::uint64_t value = 0;
                std::size_t width = 4;
                switch (rel.kind) {
                case RelocKind::Abs32:
                    value = sym_addr + static_cast<std::uint64_t>(rel.addend);
                    width = 4;
                    break;
                case RelocKind::Abs64:
                    value = sym_addr + static_cast<std::uint64_t>(rel.addend);
                    width = 8;
                    break;
                case RelocKind::Pc32:
                    value = sym_addr + static_cast<std::uint64_t>(rel.addend) -
                            place;
                    width = 4;
                    break;
                }
                put(sec.data.data() + rel.offset, value, width);
            }
        }
    }

    result.objects = std::move(objects);
    for (std::size_t gi = 0; gi < group_order.size(); ++gi) {
        OutputSection out;
        out.name = group_order[gi];
        out.addr = group_addr[gi];
        for (const auto& obj : result.objects)
            for (const auto& sec : obj.sections)
                if (sec.reachable && sec.name == out.name) {
                    std::size_t at =
                        static_cast<std::size_t>(sec.addr - out.addr);
                    if (out.data.size() < at + sec.data.size())
                        out.data.resize(at + sec.data.size(), 0);
                    std::copy(sec.data.begin(), sec.data.end(),
                              out.data.begin() + at);
                }
        result.output.push_back(std::move(out));
    }
    result.entry_addr =
        result.objects[entry_it->second.obj]
            .sections[locate(result.objects, entry_it->second).sec]
            .addr +
        locate(result.objects, entry_it->second).value;
    return result;
}

std::string format_evidence(const LinkResult& result) {
    std::ostringstream os;
    os << "binding evidence (" << result.evidence.size() << " bindings)\n";
    for (const auto& ev : result.evidence)
        os << "  " << ev.symbol << " <- " << ev.referrer << " : " << ev.chosen
           << " [" << ev.reason << "]\n";
    os << "kept sections\n";
    for (const auto& obj : result.objects)
        for (const auto& sec : obj.sections)
            if (sec.reachable) {
                std::ostringstream addr;
                addr << "0x" << std::hex << sec.addr;
                os << "  " << obj.name << ":" << sec.name << " @ " << addr.str()
                   << " size=" << sec.data.size() << "\n";
            }
    os << "entry @ 0x" << std::hex << result.entry_addr << "\n";
    return os.str();
}

} // namespace lt
