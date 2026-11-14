#include "dataeng.hpp"

#include <cstdint>
#include <initializer_list>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

int failures = 0;

#define CHECK(...)                                                                        \
    do {                                                                                  \
        if (!(__VA_ARGS__)) {                                                             \
            std::cerr << __FILE__ << ':' << __LINE__ << " CHECK failed: " #__VA_ARGS__ "\n"; \
            ++failures;                                                                   \
        }                                                                                 \
    } while (false)

std::string utf8(std::initializer_list<char32_t> code_points) {
    std::vector<dataeng::CodePoint> points;
    for (char32_t cp : code_points) {
        points.push_back({cp, {}});
    }
    return dataeng::to_utf8(points);
}

std::vector<char32_t> values(const dataeng::NormalizeResult& result) {
    std::vector<char32_t> output;
    for (const auto& cp : result.code_points) {
        output.push_back(cp.value);
    }
    return output;
}

std::size_t diagnostics(const dataeng::NormalizeResult& result, dataeng::DiagnosticKind kind) {
    std::size_t count = 0;
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.kind == kind) {
            ++count;
        }
    }
    return count;
}

void test_version_and_introspection() {
    CHECK(dataeng::unicode::version() == "16.0.0");
    CHECK(dataeng::unicode::script(U'A') == "Latin");
    CHECK(dataeng::unicode::script(0x0410) == "Cyrillic");
    CHECK(dataeng::unicode::script(0x4E00) == "Han");
    CHECK(dataeng::unicode::script(0x20AC) == "Common");
    CHECK(dataeng::unicode::script(0x0301) == "Inherited");
    CHECK(dataeng::unicode::script(0x0378) == "Unknown");
    CHECK(dataeng::unicode::is_default_ignorable(0x00AD));
    CHECK(dataeng::unicode::is_default_ignorable(0x200D));
    CHECK(!dataeng::unicode::is_default_ignorable(U'A'));
    CHECK(dataeng::unicode::canonical_combining_class(0x0301) == 230);
    CHECK(dataeng::unicode::canonical_combining_class(0x0315) == 232);
    CHECK(dataeng::unicode::canonical_combining_class(U'A') == 0);
}

void test_nfkc_and_casefold() {
    const auto fullwidth = dataeng::normalize_identifier(utf8({0xFF21, 0xFF22, 0xFF23}));
    CHECK(fullwidth.key == "abc");
    CHECK(values(fullwidth) == std::vector<char32_t>({U'a', U'b', U'c'}));

    const auto ligature = dataeng::normalize_identifier(utf8({0xFB01}));
    CHECK(ligature.key == "fi");
    CHECK(ligature.code_points.size() == 2);
    CHECK(ligature.code_points[0].source == dataeng::ByteRange{0, 3});
    CHECK(ligature.code_points[1].source == dataeng::ByteRange{0, 3});

    const auto angstrom = dataeng::normalize_identifier(utf8({0x212B}));
    CHECK(values(angstrom) == std::vector<char32_t>({0x00E5}));
    CHECK(angstrom.code_points[0].source == dataeng::ByteRange{0, 3});

    const auto sharp_s = dataeng::normalize_identifier(utf8({0x1E9E}));
    CHECK(sharp_s.key == "ss");
    CHECK(sharp_s.code_points.size() == 2);
    CHECK(sharp_s.code_points[0].source == dataeng::ByteRange{0, 3});
    CHECK(sharp_s.code_points[1].source == dataeng::ByteRange{0, 3});

    const auto dotted_i = dataeng::normalize_identifier(utf8({0x0130}));
    CHECK(values(dotted_i) == std::vector<char32_t>({U'i', 0x0307}));
    CHECK(dotted_i.code_points[0].source == dataeng::ByteRange{0, 2});
    CHECK(dotted_i.code_points[1].source == dataeng::ByteRange{0, 2});

    const auto square = dataeng::normalize_identifier(utf8({0x3300}));
    CHECK(values(square) == std::vector<char32_t>({0x30A2, 0x30D1, 0x30FC, 0x30C8}));
    for (const auto& cp : square.code_points) {
        CHECK(cp.source == dataeng::ByteRange{0, 3});
    }
}

void test_canonical_form() {
    const auto composed = dataeng::normalize_identifier(utf8({U'e', 0x0301}));
    CHECK(values(composed) == std::vector<char32_t>({0x00E9}));
    CHECK(composed.code_points[0].source == dataeng::ByteRange{0, 3});

    const auto reordered = dataeng::normalize_identifier(utf8({U'a', 0x0315, 0x0300}));
    CHECK(values(reordered) == std::vector<char32_t>({0x00E0, 0x0315}));

    const auto hangul = dataeng::normalize_identifier(utf8({0x1100, 0x1161, 0x11A8}));
    CHECK(values(hangul) == std::vector<char32_t>({0xAC01}));
    CHECK(hangul.code_points[0].source == dataeng::ByteRange{0, 9});

    const auto excluded = dataeng::normalize_identifier(utf8({0x0308, 0x0301}));
    CHECK(values(excluded) == std::vector<char32_t>({0x0308, 0x0301}));

    const auto max = dataeng::normalize_identifier(utf8({0x10FFFF}));
    CHECK(values(max) == std::vector<char32_t>({0x10FFFF}));
    CHECK(max.code_points[0].source == dataeng::ByteRange{0, 4});
}

void test_ignorable_policies() {
    const std::string input = utf8({U'a', 0x00AD, U'b'});

    dataeng::NormalizeOptions remove;
    remove.ignorables = dataeng::IgnorablePolicy::Remove;
    const auto removed = dataeng::normalize_identifier(input, remove);
    CHECK(removed.valid());
    CHECK(removed.key == "ab");
    CHECK(removed.removals.size() == 1);
    CHECK(removed.removals[0].value == 0x00AD);
    CHECK(removed.removals[0].source == dataeng::ByteRange{1, 3});
    CHECK(removed.removals[0].reason == dataeng::RemovalReason::DefaultIgnorable);

    dataeng::NormalizeOptions keep;
    keep.ignorables = dataeng::IgnorablePolicy::Keep;
    const auto kept = dataeng::normalize_identifier(input, keep);
    CHECK(kept.valid());
    CHECK(values(kept) == std::vector<char32_t>({U'a', 0x00AD, U'b'}));
    CHECK(kept.code_points[1].source == dataeng::ByteRange{1, 3});

    dataeng::NormalizeOptions reject;
    reject.ignorables = dataeng::IgnorablePolicy::Reject;
    const auto rejected = dataeng::normalize_identifier(input, reject);
    CHECK(!rejected.valid());
    CHECK(diagnostics(rejected, dataeng::DiagnosticKind::DisallowedIgnorable) == 1);
    CHECK(values(rejected).size() == 3);
}

void test_script_restriction() {
    dataeng::NormalizeOptions options;
    options.scripts = dataeng::ScriptPolicy::RejectDisallowed;
    options.allowed_scripts = {"Latin"};

    const auto latin = dataeng::normalize_identifier("A_1", options);
    CHECK(latin.valid());
    CHECK(latin.key == "a_1");

    const auto cyrillic = dataeng::normalize_identifier(utf8({0x0430, 0x0431}), options);
    CHECK(!cyrillic.valid());
    CHECK(diagnostics(cyrillic, dataeng::DiagnosticKind::DisallowedScript) == 2);

    const auto mixed = dataeng::normalize_identifier(utf8({U'a', 0x0431}), options);
    CHECK(!mixed.valid());
    CHECK(diagnostics(mixed, dataeng::DiagnosticKind::DisallowedScript) == 1);

    const auto common = dataeng::normalize_identifier(utf8({U'a', U'_', U'1', U'-'}), options);
    CHECK(common.valid());

    dataeng::NormalizeOptions hiragana = options;
    hiragana.allowed_scripts = {"Hiragana"};
    const auto prolonged = dataeng::normalize_identifier(utf8({0x3042, 0x30FC}), hiragana);
    CHECK(prolonged.valid());

    dataeng::NormalizeOptions latin_only = options;
    latin_only.allowed_scripts = {"Latn"};
    const auto alias = dataeng::normalize_identifier("Abc", latin_only);
    CHECK(alias.valid());

    dataeng::NormalizeOptions remove = options;
    remove.scripts = dataeng::ScriptPolicy::RemoveDisallowed;
    const auto stripped = dataeng::normalize_identifier(utf8({U'a', 0x0431}), remove);
    CHECK(stripped.valid());
    CHECK(stripped.key == "a");
    CHECK(stripped.removals.size() == 1);
    CHECK(stripped.removals[0].reason == dataeng::RemovalReason::DisallowedScript);

    bool threw = false;
    try {
        dataeng::NormalizeOptions bad = options;
        bad.allowed_scripts = {"Definitely_Not_A_Script"};
        dataeng::Normalizer normalizer(bad);
        (void)normalizer;
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
}

void test_utf8_isolation() {
    const std::string input("a\xE2\x28\xA1" "b", 5);
    const auto result = dataeng::normalize_identifier(input);
    CHECK(!result.valid());
    CHECK(result.key == "a(b");
    CHECK(result.segments.size() == 5);
    CHECK(result.segments[0].valid_utf8);
    CHECK(!result.segments[1].valid_utf8);
    CHECK(result.segments[2].valid_utf8);
    CHECK(!result.segments[3].valid_utf8);
    CHECK(result.segments[4].valid_utf8);
    const auto ranges = result.invalid_utf8_ranges();
    CHECK(ranges.size() == 2);
    CHECK(ranges[0] == (dataeng::ByteRange{1, 2}));
    CHECK(ranges[1] == (dataeng::ByteRange{3, 4}));
    CHECK(result.segments[1].source == dataeng::ByteRange{1, 2});
    CHECK(result.segments[3].source == dataeng::ByteRange{3, 4});

    const auto no_composition = dataeng::normalize_identifier(std::string("e\xFF\xCC\x81", 4));
    CHECK(values(no_composition) == std::vector<char32_t>({U'e', 0x0301}));
    CHECK(no_composition.code_points[0].source == dataeng::ByteRange{0, 1});
    CHECK(no_composition.code_points[1].source == dataeng::ByteRange{2, 4});
    CHECK(no_composition.invalid_utf8_ranges()[0] == (dataeng::ByteRange{1, 2}));

    const auto truncated = dataeng::normalize_identifier(std::string("\xE2\x82", 2));
    CHECK(truncated.code_points.empty());
    CHECK(truncated.invalid_utf8_ranges().size() == 1);
    CHECK(truncated.invalid_utf8_ranges()[0] == (dataeng::ByteRange{0, 2}));

    const auto three_byte_prefix = dataeng::normalize_identifier(std::string("\xF0\x9F\x92", 3));
    CHECK(three_byte_prefix.invalid_utf8_ranges().size() == 1);
    CHECK(three_byte_prefix.invalid_utf8_ranges()[0] == (dataeng::ByteRange{0, 3}));

    const auto surrogate = dataeng::normalize_identifier(std::string("\xED\xA0\x80", 3));
    CHECK(surrogate.invalid_utf8_ranges().size() == 3);
    CHECK(surrogate.invalid_utf8_ranges()[0] == (dataeng::ByteRange{0, 1}));
    CHECK(surrogate.invalid_utf8_ranges()[1] == (dataeng::ByteRange{1, 2}));
    CHECK(surrogate.invalid_utf8_ranges()[2] == (dataeng::ByteRange{2, 3}));

    const auto overlong = dataeng::normalize_identifier(std::string("\xC0\xAF", 2));
    CHECK(overlong.invalid_utf8_ranges().size() == 2);

    const auto too_high =
        dataeng::normalize_identifier(std::string("\xF4\x90\x80\x80", 4));
    CHECK(too_high.invalid_utf8_ranges().size() == 4);

    const auto euro = dataeng::normalize_identifier(std::string("\xE2\x82\xAC", 3));
    CHECK(euro.valid());
    CHECK(values(euro) == std::vector<char32_t>({0x20AC}));
    CHECK(euro.code_points[0].source == dataeng::ByteRange{0, 3});

    const auto errors = dataeng::validate_utf8(input);
    CHECK(errors.size() == 2);
    CHECK(errors[0].source == (dataeng::ByteRange{1, 2}));
    CHECK(errors[1].source == (dataeng::ByteRange{3, 4}));
}

void test_conflicts() {
    const std::vector<std::string> inputs = {"Stra\xC3\x9F" "e", "STRASSE", "strasse"};
    const auto batch = dataeng::normalize_identifiers(inputs);
    CHECK(batch.entries.size() == 3);
    CHECK(batch.conflicts.size() == 1);
    CHECK(batch.conflicts[0].key == "strasse");
    CHECK(batch.conflicts[0].entries == std::vector<std::size_t>({0, 1, 2}));
    CHECK(batch.conflicts[0].distinct_originals.size() == 3);
    CHECK(batch.conflicts[0].is_conflict());

    const std::vector<std::string> duplicates = {"beta", "beta"};
    const auto same = dataeng::normalize_identifiers(duplicates);
    CHECK(same.entries.size() == 2);
    CHECK(same.groups.size() == 1);
    CHECK(same.groups[0].entries.size() == 2);
    CHECK(same.groups[0].distinct_originals.size() == 1);
    CHECK(same.conflicts.empty());

    const std::vector<std::string> mixed = {"one", "two", "ONE"};
    const auto distinct = dataeng::normalize_identifiers(mixed);
    CHECK(distinct.entries.size() == 3);
    CHECK(distinct.groups.size() == 2);
    CHECK(distinct.conflicts.size() == 1);
    CHECK(distinct.conflicts[0].key == "one");
    CHECK(distinct.conflicts[0].entries == std::vector<std::size_t>({0, 2}));

    const std::string soft_hyphen(utf8({0x00AD}));
    const std::string zero_width_joiner(utf8({0x200D}));
    const std::vector<std::string> empty_keys = {soft_hyphen, zero_width_joiner};
    const auto empties = dataeng::normalize_identifiers(empty_keys);
    CHECK(empties.conflicts.size() == 1);
    CHECK(empties.conflicts[0].key.empty());
    CHECK(empties.conflicts[0].entries.size() == 2);

    const std::vector<std::string> invalid_inputs = {"a", std::string("\xFF", 1)};
    const auto invalid = dataeng::normalize_identifiers(invalid_inputs);
    CHECK(invalid.entries.size() == 2);
    CHECK(invalid.groups.size() == 1);
    CHECK(!invalid.valid());
}

void test_options() {
    bool threw = false;
    try {
        dataeng::NormalizeOptions options;
        options.unicode_version = "15.0.0";
        dataeng::Normalizer normalizer(options);
        (void)normalizer;
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);

    dataeng::NormalizeOptions accepted;
    accepted.unicode_version = "16";
    dataeng::Normalizer normalizer(accepted);
    CHECK(normalizer.options().unicode_version == "16");
}

}  // namespace

int main() {
    test_version_and_introspection();
    test_nfkc_and_casefold();
    test_canonical_form();
    test_ignorable_policies();
    test_script_restriction();
    test_utf8_isolation();
    test_conflicts();
    test_options();

    if (failures != 0) {
        std::cerr << failures << " test check(s) failed\n";
        return 1;
    }
    std::cout << "all dataeng tests passed\n";
    return 0;
}
