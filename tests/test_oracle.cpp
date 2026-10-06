#include "test_util.h"

#include <algorithm>
#include <cstdio>
#include <random>
#include <string>
#include <vector>

// Builds a deterministic pseudo-random object graph with strong/weak mixes,
// guaranteed cycles, and unreachable sections, then cross-checks the linker
// against the whole-graph interpreter.
int main() {
    std::mt19937 rng(20261006);
    std::vector<lnk::ObjectFile> objects;

    constexpr int kObjects = 10;
    constexpr int kSections = 3;

    // First pass: create sections and symbols.
    for (int oi = 0; oi < kObjects; ++oi) {
        lnk::ObjectFile o;
        o.name = "obj" + std::to_string(oi) + ".o";
        for (int si = 0; si < kSections; ++si) {
            std::size_t align = 1u << (rng() % 4);  // 1, 2, 4, 8
            o.sections.push_back(
                make_section("sec" + std::to_string(si), 8 + rng() % 24, align));
            std::string sym = "s" + std::to_string(oi) + "_" + std::to_string(si);
            o.symbols.push_back(defined_sym(sym, si));
        }
        objects.push_back(o);
    }

    // Weak duplicates of a few symbols in later objects (must never win
    // against the strong originals, and first-in-order among themselves).
    for (int oi = 4; oi < kObjects; oi += 2) {
        lnk::ObjectFile dup;
        dup.name = "weakdup" + std::to_string(oi) + ".o";
        dup.sections.push_back(make_section(".text", 8));
        dup.symbols.push_back(
            defined_sym("s1_0", 0, 0, lnk::Binding::Weak));
        objects.push_back(dup);
    }

    // Second pass: random references between sections, forming cycles.
    std::uniform_int_distribution<int> obj_dist(0, kObjects - 1);
    std::uniform_int_distribution<int> sec_dist(0, kSections - 1);
    for (int oi = 0; oi < kObjects; ++oi) {
        for (int si = 0; si < kSections; ++si) {
            auto& sec = objects[oi].sections[si];
            // Ring edge guarantees the whole graph is one big cycle.
            int next = (oi + 1) % kObjects;
            add_reloc(sec, 0, "s" + std::to_string(next) + "_" +
                                 std::to_string(si));
            // Extra random edges.
            int extra = rng() % 3;
            for (int e = 0; e < extra; ++e) {
                std::size_t off = 8 * (1 + e);
                if (off + 8 > sec.data.size()) break;
                std::string target = "s" + std::to_string(obj_dist(rng)) + "_" +
                                     std::to_string(sec_dist(rng));
                add_reloc(sec, off, target, lnk::RelocType::Abs64,
                          rng() % 4);
            }
        }
    }

    // A fully disconnected object that must be garbage-collected.
    lnk::ObjectFile dead;
    dead.name = "dead.o";
    dead.sections.push_back(make_section(".text", 8));
    dead.symbols.push_back(defined_sym("dead_fn", 0));
    objects.push_back(dead);

    lnk::LinkResult res = lnk::Linker().link(objects, "s0_0");

    // The ring keeps every obj* section alive; the weak duplicates lose to
    // the strong original and are collected together with dead.o.
    CHECK(res.kept_sections.size() ==
          static_cast<std::size_t>(kObjects) * kSections);
    CHECK(res.gc_sections.size() == 4);
    CHECK(std::find(res.gc_sections.begin(), res.gc_sections.end(),
                    "dead.o:.text") != res.gc_sections.end());
    CHECK(std::find(res.gc_sections.begin(), res.gc_sections.end(),
                    "weakdup4.o:.text") != res.gc_sections.end());

    // Weak duplicates never override the strong original.
    const auto* b = find_binding(res, "s1_0");
    CHECK(b != nullptr);
    CHECK(b->defined_in == "obj1.o");
    CHECK(b->binding == lnk::Binding::Strong);

    cross_check(objects, "s0_0", res);
    std::puts("test_oracle: OK");
    return 0;
}
