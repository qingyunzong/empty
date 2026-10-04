#include "lt/interp.hpp"
#include "lt/link.hpp"
#include "lt/parse.hpp"

#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            ++failures;                                                    \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": "    \
                      << #cond << "\n";                                    \
        }                                                                  \
    } while (0)

lt::Object obj(const std::string& text) {
    std::istringstream in(text);
    return lt::parse_object(in, "<test>");
}

std::uint64_t read_le(const lt::Section& sec, std::size_t off,
                      std::size_t width) {
    std::uint64_t v = 0;
    for (std::size_t i = 0; i < width; ++i)
        v |= static_cast<std::uint64_t>(sec.data[off + i]) << (8 * i);
    return v;
}

const lt::Section* find_sec(const lt::LinkResult& r, const std::string& o,
                            const std::string& s) {
    for (const auto& ob : r.objects)
        for (const auto& sec : ob.sections)
            if (ob.name == o && sec.name == s)
                return &sec;
    return nullptr;
}

// 1. Strong/strong conflict is rejected.
void test_strong_conflict() {
    auto a = obj("object a\nsection .text size=8\nsym f strong def .text 0\n");
    auto b = obj("object b\nsection .text size=8\nsym f strong def .text 0\n");
    bool threw = false;
    try {
        lt::LinkOptions o;
        o.entry = "f";
        lt::link({a, b}, o);
    } catch (const std::runtime_error& e) {
        threw = true;
        CHECK(std::string(e.what()).find("strong definition conflict") !=
              std::string::npos);
    }
    CHECK(threw);
}

// 2. Weak/weak: first object in input order wins; evidence says so.
void test_weak_order() {
    auto a = obj("object first\nsection .text size=8\n"
                 "sym entry strong def .text 0\n"
                 "sym hook weak def .text 1\n"
                 "reloc .text 0 ABS64 hook\n");
    auto b = obj("object second\nsection .text size=8\n"
                 "sym hook weak def .text 2\n");
    lt::LinkOptions o;
    o.entry = "entry";
    auto r = lt::link({a, b}, o);
    bool saw_first = false;
    for (const auto& ev : r.evidence)
        if (ev.symbol == "hook") {
            CHECK(ev.chosen.find("first:") == 0);
            CHECK(ev.reason.find("first in input order") !=
                  std::string::npos);
            saw_first = true;
        }
    CHECK(saw_first);
    CHECK(lt::interpret_check(r, o).empty());
}

// 3. Strong beats weak regardless of input order.
void test_strong_beats_weak() {
    auto weak_first = obj("object w\nsection .text size=8\n"
                          "sym hook weak def .text 0\n");
    auto strong_second = obj("object s\nsection .text size=8\n"
                             "sym entry strong def .text 0\n"
                             "sym hook strong def .text 4\n"
                             "reloc .text 0 ABS64 hook\n");
    lt::LinkOptions o;
    o.entry = "entry";
    auto r = lt::link({weak_first, strong_second}, o);
    for (const auto& ev : r.evidence)
        if (ev.symbol == "hook" && ev.referrer != "<entry>") {
            CHECK(ev.chosen.find("s:") == 0);
            CHECK(ev.reason.find("overrides weak") != std::string::npos);
        }
    CHECK(lt::interpret_check(r, o).empty());
}

// 4. GC keeps only reachable sections; alignment is honored.
void test_gc_and_layout() {
    auto a = obj("object a\n"
                 "section .text size=16 align=16\n"
                 "section .dead size=32 align=8\n"
                 "sym entry strong def .text 0\n");
    auto b = obj("object b\n"
                 "section .text size=8 align=8\n"
                 "section .data size=4 align=4\n"
                 "sym helper strong def .text 0\n"
                 "sym datum strong def .data 0\n");
    // a references helper; datum is unreachable and must be collected.
    auto a2 = obj("object a\n"
                  "section .text size=16 align=16\n"
                  "section .dead size=32 align=8\n"
                  "sym entry strong def .text 0\n"
                  "reloc .text 0 ABS64 helper\n");
    lt::LinkOptions o;
    o.entry = "entry";
    o.base = 0x1000;
    auto r = lt::link({a2, b}, o);
    const auto* ta = find_sec(r, "a", ".text");
    const auto* dead = find_sec(r, "a", ".dead");
    const auto* tb = find_sec(r, "b", ".text");
    const auto* data = find_sec(r, "b", ".data");
    CHECK(ta && tb && dead && data);
    CHECK(ta->reachable && tb->reachable);
    CHECK(!dead->reachable);
    CHECK(!data->reachable);
    CHECK(ta->addr == 0x1000);
    CHECK(tb->addr == 0x1010); // after 16 bytes, align 8
    CHECK(read_le(*ta, 0, 8) == tb->addr);
    CHECK(lt::interpret_check(r, o).empty());
}

// 5. Circular references between sections are legal and both are kept.
void test_cycle() {
    auto a = obj("object a\n"
                 "section .text size=8\n"
                 "sym entry strong def .text 0\n"
                 "sym fa strong def .text 0\n"
                 "reloc .text 0 ABS64 fb\n");
    auto b = obj("object b\n"
                 "section .text size=8\n"
                 "sym fb strong def .text 0\n"
                 "reloc .text 0 ABS64 fa\n");
    lt::LinkOptions o;
    o.entry = "entry";
    auto r = lt::link({a, b}, o);
    const auto* ta = find_sec(r, "a", ".text");
    const auto* tb = find_sec(r, "b", ".text");
    CHECK(ta->reachable && tb->reachable);
    CHECK(read_le(*ta, 0, 8) == tb->addr);
    CHECK(read_le(*tb, 0, 8) == ta->addr);
    CHECK(lt::interpret_check(r, o).empty());
}

// 6. PC32 relocation is place-relative.
void test_pc32() {
    auto a = obj("object a\n"
                 "section .text size=16\n"
                 "sym entry strong def .text 0\n"
                 "sym target strong def .text 12\n"
                 "reloc .text 4 PC32 target\n");
    lt::LinkOptions o;
    o.entry = "entry";
    o.base = 0x4000;
    auto r = lt::link({a}, o);
    const auto* t = find_sec(r, "a", ".text");
    // S + A - P = (addr+12) - (addr+4) = 8
    CHECK(read_le(*t, 4, 4) == 8);
    CHECK(lt::interpret_check(r, o).empty());
}

// 7. Weak undefined resolves to 0; strong undefined is an error.
void test_undef() {
    auto weak = obj("object w\n"
                    "section .text size=8\n"
                    "sym entry strong def .text 0\n"
                    "sym maybe weak undef\n"
                    "reloc .text 0 ABS64 maybe\n");
    lt::LinkOptions o;
    o.entry = "entry";
    auto r = lt::link({weak}, o);
    CHECK(read_le(*find_sec(r, "w", ".text"), 0, 8) == 0);
    CHECK(lt::interpret_check(r, o).empty());

    auto strong = obj("object s\n"
                      "section .text size=8\n"
                      "sym entry strong def .text 0\n"
                      "sym missing strong undef\n"
                      "reloc .text 0 ABS64 missing\n");
    bool threw = false;
    try {
        lt::link({strong}, o);
    } catch (const std::runtime_error& e) {
        threw = true;
        CHECK(std::string(e.what()).find("unresolved symbol") !=
              std::string::npos);
    }
    CHECK(threw);
}

// 8. keep-flagged sections survive GC even without references.
void test_keep_root() {
    auto a = obj("object a\n"
                 "section .text size=8\n"
                 "section .note size=4 keep\n"
                 "sym entry strong def .text 0\n");
    lt::LinkOptions o;
    o.entry = "entry";
    auto r = lt::link({a}, o);
    CHECK(find_sec(r, "a", ".note")->reachable);
    CHECK(lt::interpret_check(r, o).empty());
}

// 9. Missing entry symbol is an error.
void test_missing_entry() {
    auto a = obj("object a\nsection .text size=8\nsym f strong def .text 0\n");
    lt::LinkOptions o;
    o.entry = "entry";
    bool threw = false;
    try {
        lt::link({a}, o);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
}

// 10. Combined graph: cycle + weak chain + addends, fully cross-checked.
void test_combined() {
    auto a = obj("object a\n"
                 "section .text size=24 align=8\n"
                 "sym entry strong def .text 0\n"
                 "sym handler weak def .text 8\n"
                 "reloc .text 0 ABS64 handler\n"
                 "reloc .text 8 ABS64 table 16\n"
                 "reloc .text 16 PC32 entry\n");
    auto b = obj("object b\n"
                 "section .rodata size=32 align=16\n"
                 "sym table strong def .rodata 0\n"
                 "reloc .rodata 0 ABS64 handler\n");
    auto c = obj("object c\n"
                 "section .text size=8\n"
                 "sym handler weak def .text 0\n");
    lt::LinkOptions o;
    o.entry = "entry";
    o.base = 0x8000;
    auto r = lt::link({a, b, c}, o);
    const auto* ta = find_sec(r, "a", ".text");
    const auto* rb = find_sec(r, "b", ".rodata");
    // weak/weak: a's handler wins (input order), c's section is unreachable.
    CHECK(!find_sec(r, "c", ".text")->reachable);
    CHECK(read_le(*ta, 0, 8) == ta->addr + 8);
    CHECK(read_le(*ta, 8, 8) == rb->addr + 16);
    CHECK(read_le(*rb, 0, 8) == ta->addr + 8);
    CHECK(rb->addr % 16 == 0);
    CHECK(lt::interpret_check(r, o).empty());
}

} // namespace

int main() {
    test_strong_conflict();
    test_weak_order();
    test_strong_beats_weak();
    test_gc_and_layout();
    test_cycle();
    test_pc32();
    test_undef();
    test_keep_root();
    test_missing_entry();
    test_combined();
    if (failures == 0) {
        std::cout << "all unit tests passed\n";
        return 0;
    }
    std::cerr << failures << " check(s) failed\n";
    return 1;
}
