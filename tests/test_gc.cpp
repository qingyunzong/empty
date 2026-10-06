#include "test_util.h"

#include <algorithm>
#include <cstdio>

int main() {
    lnk::ObjectFile a;
    a.name = "a.o";
    a.sections.push_back(make_section(".text", 8));   // live
    a.sections.push_back(make_section(".dead", 8));   // unreachable
    add_reloc(a.sections[0], 0, "used");
    // A dead section may reference undefined symbols without failing the link.
    add_reloc(a.sections[1], 0, "nonexistent");
    a.symbols.push_back(defined_sym("main", 0));
    a.symbols.push_back(defined_sym("dead_fn", 1));

    lnk::ObjectFile b;
    b.name = "b.o";
    b.sections.push_back(make_section(".text", 8));   // live
    b.sections.push_back(make_section(".unused", 4)); // unreachable
    b.symbols.push_back(defined_sym("used", 0));
    b.symbols.push_back(defined_sym("unused_fn", 1));

    std::vector<lnk::ObjectFile> objects = {a, b};
    lnk::LinkResult res = lnk::Linker().link(objects, "main");

    CHECK(res.kept_sections.size() == 2);
    CHECK(find_kept(res, "a.o", ".text") != nullptr);
    CHECK(find_kept(res, "b.o", ".text") != nullptr);
    CHECK(find_kept(res, "a.o", ".dead") == nullptr);
    CHECK(find_kept(res, "b.o", ".unused") == nullptr);

    CHECK(res.gc_sections.size() == 2);
    CHECK(std::find(res.gc_sections.begin(), res.gc_sections.end(), "a.o:.dead") !=
          res.gc_sections.end());
    CHECK(std::find(res.gc_sections.begin(), res.gc_sections.end(), "b.o:.unused") !=
          res.gc_sections.end());

    // Dead symbols are still reported in the binding evidence.
    CHECK(find_binding(res, "dead_fn") != nullptr);
    CHECK(find_binding(res, "unused_fn") != nullptr);

    cross_check(objects, "main", res);
    std::puts("test_gc: OK");
    return 0;
}
