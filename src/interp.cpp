#include "lt/interp.hpp"

#include <deque>
#include <map>
#include <set>
#include <sstream>

namespace lt {

namespace {

// The interpreter keeps its own resolution state, written independently of
// the linker's Symtab so the cross-check is meaningful.
struct Interp {
    const std::vector<Object>& objects;
    std::map<std::string, std::pair<std::size_t, std::size_t>> defs; // (obj,sym)
    std::set<std::string> weak_undefs;

    explicit Interp(const std::vector<Object>& objs) : objects(objs) {
        for (std::size_t oi = 0; oi < objects.size(); ++oi)
            for (std::size_t si = 0; si < objects[oi].symbols.size(); ++si) {
                const auto& sym = objects[oi].symbols[si];
                if (!sym.defined) {
                    if (sym.binding == Binding::Weak)
                        weak_undefs.insert(sym.name);
                    continue;
                }
                bool weak = sym.binding == Binding::Weak;
                auto it = defs.find(sym.name);
                if (it == defs.end()) {
                    defs.emplace(sym.name, std::pair{oi, si});
                } else {
                    const auto& cur =
                        objects[it->second.first].symbols[it->second.second];
                    bool cur_weak = cur.binding == Binding::Weak;
                    if (cur_weak && !weak)
                        it->second = {oi, si}; // strong beats weak
                    // weak/weak: keep first-seen (input order)
                }
            }
    }

    // Address of a defined symbol, using the linker's assigned addresses.
    std::uint64_t addr_of(std::size_t oi, std::size_t si) const {
        const auto& sym = objects[oi].symbols[si];
        for (const auto& sec : objects[oi].sections)
            if (sec.name == sym.section)
                return sec.addr + sym.value;
        return 0;
    }
};

std::string hex64(std::uint64_t v) {
    std::ostringstream os;
    os << "0x" << std::hex << v;
    return os.str();
}

} // namespace

std::vector<std::string> interpret_check(const LinkResult& result,
                                         const LinkOptions& opts) {
    std::vector<std::string> errors;
    Interp interp(result.objects);

    // 1. Every linker binding must match the interpreter's own resolution.
    for (const auto& ev : result.evidence) {
        auto it = interp.defs.find(ev.symbol);
        if (it == interp.defs.end()) {
            if (!interp.weak_undefs.count(ev.symbol))
                errors.push_back("interpreter has no resolution for '" +
                                 ev.symbol + "' but linker bound it");
            else if (ev.chosen != "<null>")
                errors.push_back("weak-undef '" + ev.symbol +
                                 "' should bind to <null>, got " + ev.chosen);
            continue;
        }
        const auto& sym =
            result.objects[it->second.first].symbols[it->second.second];
        std::string want = result.objects[it->second.first].name + ":" +
                           sym.section + "+0x" +
                           ([&] { std::ostringstream os;
                                  os << std::hex << sym.value;
                                  return os.str(); })();
        if (ev.chosen != want)
            errors.push_back("binding mismatch for '" + ev.symbol + "': linker=" +
                             ev.chosen + " interpreter=" + want);
    }

    // 2. Independent reachability closure over the full graph must equal the
    //    linker's kept set (cycles terminate via the visited set).
    {
        std::set<std::pair<std::size_t, std::size_t>> seen;
        std::deque<std::pair<std::size_t, std::size_t>> wl;
        auto mark = [&](std::size_t oi, const std::string& sec_name) {
            for (std::size_t si = 0;
                 si < result.objects[oi].sections.size(); ++si)
                if (result.objects[oi].sections[si].name == sec_name &&
                    seen.emplace(oi, si).second)
                    wl.emplace_back(oi, si);
        };
        auto entry = interp.defs.find(opts.entry);
        if (entry == interp.defs.end()) {
            errors.push_back("interpreter: entry '" + opts.entry +
                             "' undefined");
        } else {
            mark(entry->second.first,
                 result.objects[entry->second.first]
                     .symbols[entry->second.second]
                     .section);
        }
        for (std::size_t oi = 0; oi < result.objects.size(); ++oi)
            for (std::size_t si = 0; si < result.objects[oi].sections.size();
                 ++si)
                if (result.objects[oi].sections[si].keep)
                    if (seen.emplace(oi, si).second)
                        wl.emplace_back(oi, si);
        while (!wl.empty()) {
            auto [oi, si] = wl.front();
            wl.pop_front();
            for (const auto& rel : result.objects[oi].sections[si].relocs) {
                auto it = interp.defs.find(rel.symbol);
                if (it == interp.defs.end())
                    continue; // weak undef, no target section
                mark(it->second.first,
                     result.objects[it->second.first]
                         .symbols[it->second.second]
                         .section);
            }
        }
        for (std::size_t oi = 0; oi < result.objects.size(); ++oi)
            for (std::size_t si = 0; si < result.objects[oi].sections.size();
                 ++si) {
                const auto& sec = result.objects[oi].sections[si];
                bool interp_reachable = seen.count({oi, si}) != 0;
                bool kept = sec.reachable;
                if (!opts.gc)
                    interp_reachable = true; // linker keeps everything
                if (interp_reachable != kept)
                    errors.push_back("reachability mismatch: " +
                                     result.objects[oi].name + ":" + sec.name);
            }
    }

    // 3. Re-interpret relocations of kept sections at linked addresses and
    //    compare against the linked bytes.
    for (const auto& obj : result.objects) {
        for (const auto& sec : obj.sections) {
            if (!sec.reachable)
                continue;
            for (const auto& rel : sec.relocs) {
                std::uint64_t sym_addr = 0;
                auto it = interp.defs.find(rel.symbol);
                if (it != interp.defs.end())
                    sym_addr = interp.addr_of(it->second.first,
                                              it->second.second);
                std::uint64_t place = sec.addr + rel.offset;
                std::uint64_t want = 0;
                std::size_t width = 4;
                switch (rel.kind) {
                case RelocKind::Abs32:
                    want = sym_addr + static_cast<std::uint64_t>(rel.addend);
                    width = 4;
                    break;
                case RelocKind::Abs64:
                    want = sym_addr + static_cast<std::uint64_t>(rel.addend);
                    width = 8;
                    break;
                case RelocKind::Pc32:
                    want = sym_addr + static_cast<std::uint64_t>(rel.addend) -
                           place;
                    width = 4;
                    break;
                }
                std::uint64_t got = 0;
                for (std::size_t i = 0; i < width; ++i)
                    got |= static_cast<std::uint64_t>(
                               sec.data[rel.offset + i])
                           << (8 * i);
                if (width < 8)
                    want &= (std::uint64_t{1} << (width * 8)) - 1;
                if (got != want)
                    errors.push_back("reloc mismatch at " + obj.name + ":" +
                                     sec.name + "+" + hex64(rel.offset) +
                                     ": linked=" + hex64(got) +
                                     " interpreted=" + hex64(want));
            }
        }
    }
    return errors;
}

} // namespace lt
