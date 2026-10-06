#include "test_util.h"

#include <cstdio>
#include <string>

static bool throws_link_error(const std::vector<lnk::ObjectFile>& objects,
                              const std::string& entry,
                              const std::string& needle,
                              std::uint64_t base = 0x1000) {
    try {
        lnk::Linker().link(objects, entry, base);
    } catch (const lnk::LinkError& e) {
        return std::string(e.what()).find(needle) != std::string::npos;
    }
    return false;
}

int main() {
    // Two strong definitions of the same symbol -> rejected.
    {
        lnk::ObjectFile a;
        a.name = "a.o";
        a.sections.push_back(make_section(".text", 8));
        a.symbols.push_back(defined_sym("foo", 0));
        lnk::ObjectFile b;
        b.name = "b.o";
        b.sections.push_back(make_section(".text", 8));
        b.symbols.push_back(defined_sym("foo", 0));
        CHECK(throws_link_error({a, b}, "foo", "multiple strong definitions"));
    }

    // Undefined entry symbol.
    {
        lnk::ObjectFile a;
        a.name = "a.o";
        a.sections.push_back(make_section(".text", 8));
        a.symbols.push_back(defined_sym("foo", 0));
        CHECK(throws_link_error({a}, "missing", "undefined entry symbol"));
    }

    // Undefined symbol referenced from a kept section.
    {
        lnk::ObjectFile a;
        a.name = "a.o";
        a.sections.push_back(make_section(".text", 8));
        add_reloc(a.sections[0], 0, "nowhere");
        a.symbols.push_back(defined_sym("main", 0));
        CHECK(throws_link_error({a}, "main", "undefined symbol nowhere"));
    }

    // Abs32 relocation overflow.
    {
        lnk::ObjectFile a;
        a.name = "a.o";
        a.sections.push_back(make_section(".text", 8));
        add_reloc(a.sections[0], 0, "target", lnk::RelocType::Abs32);
        a.symbols.push_back(defined_sym("main", 0));
        lnk::ObjectFile b;
        b.name = "b.o";
        b.sections.push_back(make_section(".text", 8));
        b.symbols.push_back(defined_sym("target", 0));
        CHECK(throws_link_error({a, b}, "main", "overflow", 0x100000000ull));
    }

    std::puts("test_conflicts: OK");
    return 0;
}
