#include "test_util.h"

#include <cstdio>

int main() {
    lnk::ObjectFile main_obj;
    main_obj.name = "main.o";
    main_obj.sections.push_back(make_section(".text", 16, 16));
    add_reloc(main_obj.sections[0], 0, "helper");
    add_reloc(main_obj.sections[0], 8, "data", lnk::RelocType::Abs32, 4);
    main_obj.symbols.push_back(defined_sym("main", 0));

    lnk::ObjectFile lib_obj;
    lib_obj.name = "lib.o";
    lib_obj.sections.push_back(make_section(".text", 8, 16));
    lib_obj.sections.push_back(make_section(".data", 4, 4));
    lib_obj.symbols.push_back(defined_sym("helper", 0));
    lib_obj.symbols.push_back(defined_sym("data", 1));

    std::vector<lnk::ObjectFile> objects = {main_obj, lib_obj};
    lnk::LinkResult res = lnk::Linker().link(objects, "main", 0x1000);

    // Layout: main.o:.text @0x1000, lib.o:.text @0x1010, lib.o:.data @0x1018.
    CHECK(res.kept_sections.size() == 3);
    CHECK(res.gc_sections.empty());
    const auto* main_text = find_kept(res, "main.o", ".text");
    const auto* lib_text = find_kept(res, "lib.o", ".text");
    const auto* lib_data = find_kept(res, "lib.o", ".data");
    CHECK(main_text && lib_text && lib_data);
    CHECK(main_text->address == 0x1000);
    CHECK(lib_text->address == 0x1010);
    CHECK(lib_data->address == 0x1018);

    // Entry address.
    CHECK(res.entry_address == 0x1000);

    // Relocated bytes: helper -> 0x1010 (Abs64), data + 4 -> 0x101C (Abs32).
    CHECK(read_le(main_text->relocated_data, 0, 8) == 0x1010);
    CHECK(read_le(main_text->relocated_data, 8, 4) == 0x101C);

    // Binding evidence.
    const auto* b_main = find_binding(res, "main");
    const auto* b_helper = find_binding(res, "helper");
    const auto* b_data = find_binding(res, "data");
    CHECK(b_main && b_helper && b_data);
    CHECK(b_main->defined_in == "main.o");
    CHECK(b_helper->defined_in == "lib.o");
    CHECK(b_data->defined_in == "lib.o");
    CHECK(b_helper->reason == "unique strong definition");

    // Reachability evidence.
    CHECK(main_text->reason == "entry section (symbol main)");
    CHECK(lib_text->reason == "referenced by main.o:.text via symbol helper");

    cross_check(objects, "main", res);
    std::puts("test_basic: OK");
    return 0;
}
