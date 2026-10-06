#include "test_util.h"

#include <cstdio>

int main() {
    // a -> b -> a: a reference cycle across objects must link cleanly.
    lnk::ObjectFile a;
    a.name = "a.o";
    a.sections.push_back(make_section(".text", 8));
    add_reloc(a.sections[0], 0, "fn_b");
    a.symbols.push_back(defined_sym("fn_a", 0));

    lnk::ObjectFile b;
    b.name = "b.o";
    b.sections.push_back(make_section(".text", 8));
    add_reloc(b.sections[0], 0, "fn_a");
    b.symbols.push_back(defined_sym("fn_b", 0));

    std::vector<lnk::ObjectFile> objects = {a, b};
    lnk::LinkResult res = lnk::Linker().link(objects, "fn_a");

    // Both sections survive GC and point at each other.
    CHECK(res.kept_sections.size() == 2);
    CHECK(res.gc_sections.empty());
    const auto* sec_a = find_kept(res, "a.o", ".text");
    const auto* sec_b = find_kept(res, "b.o", ".text");
    CHECK(sec_a && sec_b);
    CHECK(read_le(sec_a->relocated_data, 0, 8) == sec_b->address);
    CHECK(read_le(sec_b->relocated_data, 0, 8) == sec_a->address);
    CHECK(res.entry_address == sec_a->address);

    // A three-node self-inclusive cycle: c -> c (self reference).
    lnk::ObjectFile c;
    c.name = "c.o";
    c.sections.push_back(make_section(".text", 16));
    add_reloc(c.sections[0], 0, "self");
    add_reloc(c.sections[0], 8, "fn_a");
    c.symbols.push_back(defined_sym("self", 0));

    std::vector<lnk::ObjectFile> objects2 = {c, a, b};
    lnk::LinkResult res2 = lnk::Linker().link(objects2, "self");
    CHECK(res2.kept_sections.size() == 3);
    const auto* sec_c = find_kept(res2, "c.o", ".text");
    CHECK(sec_c != nullptr);
    CHECK(read_le(sec_c->relocated_data, 0, 8) == sec_c->address);

    cross_check(objects, "fn_a", res);
    cross_check(objects2, "self", res2);
    std::puts("test_circular: OK");
    return 0;
}
