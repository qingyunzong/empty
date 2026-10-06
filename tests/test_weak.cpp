#include "test_util.h"

#include <cstdio>

static lnk::ObjectFile obj_with_sym(const std::string& obj_name,
                                    const std::string& sym_name,
                                    lnk::Binding binding) {
    lnk::ObjectFile o;
    o.name = obj_name;
    o.sections.push_back(make_section(".text", 8));
    o.symbols.push_back(defined_sym(sym_name, 0, 0, binding));
    return o;
}

int main() {
    // Strong overrides weak, regardless of input order (weak first here).
    {
        std::vector<lnk::ObjectFile> objects = {
            obj_with_sym("weak.o", "foo", lnk::Binding::Weak),
            obj_with_sym("strong.o", "foo", lnk::Binding::Strong),
        };
        lnk::LinkResult res = lnk::Linker().link(objects, "foo");
        const auto* b = find_binding(res, "foo");
        CHECK(b != nullptr);
        CHECK(b->defined_in == "strong.o");
        CHECK(b->binding == lnk::Binding::Strong);
        CHECK(b->reason == "strong definition overrides 1 weak");
        cross_check(objects, "foo", res);
    }

    // Weak-only: first definition in object input order wins.
    {
        std::vector<lnk::ObjectFile> objects = {
            obj_with_sym("first.o", "foo", lnk::Binding::Weak),
            obj_with_sym("second.o", "foo", lnk::Binding::Weak),
            obj_with_sym("third.o", "foo", lnk::Binding::Weak),
        };
        lnk::LinkResult res = lnk::Linker().link(objects, "foo");
        const auto* b = find_binding(res, "foo");
        CHECK(b != nullptr);
        CHECK(b->defined_in == "first.o");
        CHECK(b->reason == "first weak definition in input order (of 3)");
        cross_check(objects, "foo", res);
    }

    // Reordering the inputs changes which weak definition wins.
    {
        std::vector<lnk::ObjectFile> objects = {
            obj_with_sym("zeta.o", "foo", lnk::Binding::Weak),
            obj_with_sym("alpha.o", "foo", lnk::Binding::Weak),
        };
        lnk::LinkResult res = lnk::Linker().link(objects, "foo");
        const auto* b = find_binding(res, "foo");
        CHECK(b != nullptr);
        CHECK(b->defined_in == "zeta.o");
        cross_check(objects, "foo", res);
    }

    // A weak definition satisfies references from other objects.
    {
        lnk::ObjectFile user;
        user.name = "user.o";
        user.sections.push_back(make_section(".text", 8));
        add_reloc(user.sections[0], 0, "malloc");
        user.symbols.push_back(defined_sym("main", 0));

        lnk::ObjectFile fallback;
        fallback.name = "fallback.o";
        fallback.sections.push_back(make_section(".text", 8));
        fallback.symbols.push_back(defined_sym("malloc", 0, 0, lnk::Binding::Weak));

        std::vector<lnk::ObjectFile> objects = {user, fallback};
        lnk::LinkResult res = lnk::Linker().link(objects, "main");
        const auto* b = find_binding(res, "malloc");
        CHECK(b != nullptr);
        CHECK(b->defined_in == "fallback.o");
        const auto* user_text = find_kept(res, "user.o", ".text");
        const auto* fb_text = find_kept(res, "fallback.o", ".text");
        CHECK(user_text && fb_text);
        CHECK(read_le(user_text->relocated_data, 0, 8) == fb_text->address);
        cross_check(objects, "main", res);
    }

    std::puts("test_weak: OK");
    return 0;
}
