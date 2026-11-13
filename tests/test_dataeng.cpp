#include "dataeng.hpp"

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

int failures = 0;

#define CHECK(condition)                                                       \
    do {                                                                       \
        if (!(condition)) {                                                    \
            std::cerr << __FILE__ << ':' << __LINE__ << ": CHECK failed: "     \
                      << #condition << '\n';                                   \
            ++failures;                                                        \
        }                                                                      \
    } while (false)

const dataeng::CandidateEdge* find_edge(const dataeng::CandidateGraph& graph,
                                        std::size_t begin, std::size_t end,
                                        dataeng::EdgeKind kind,
                                        std::string_view id = {}) {
    for (const auto& edge : graph.edges) {
        if (edge.span.begin == begin && edge.span.end == end &&
            edge.kind == kind &&
            (id.empty() || edge.entry_id == id)) {
            return &edge;
        }
    }
    return nullptr;
}

void check_path_shape(const dataeng::CandidateGraph& graph,
                      const dataeng::CandidatePath& path) {
    CHECK(path.edges.empty() == (graph.character_count == 0));
    if (path.edges.empty()) {
        CHECK(path.total_cost == 0);
        return;
    }
    CHECK(path.edges.front().span.begin == 0);
    CHECK(path.edges.back().span.end == graph.character_count);
    CHECK(path.edges.front().bytes.begin == 0);
    CHECK(path.edges.back().bytes.end == path.source_text.size());
    std::string rebuilt;
    for (std::size_t i = 1; i < path.edges.size(); ++i) {
        CHECK(path.edges[i - 1].span.end == path.edges[i].span.begin);
        CHECK(path.edges[i - 1].bytes.end == path.edges[i].bytes.begin);
    }
    for (const auto& edge : path.edges) {
        rebuilt += edge.text;
    }
    CHECK(rebuilt == path.source_text);
}

dataeng::AdminDictionary make_address_dictionary() {
    dataeng::AdminDictionary dictionary("2026.1");
    dictionary
        .add("110000", "北京市", {"北京"}, dataeng::RegionLevel::City)
        .add("110105", "朝阳区", {"朝阳"}, dataeng::RegionLevel::District,
             "110000");
    return dictionary;
}

void test_utf8_spans_and_overlaps() {
    dataeng::AddressSegmenter segmenter(make_address_dictionary());
    const std::string text = "北京市朝阳区";
    const dataeng::CandidateGraph graph = segmenter.build_graph(text);

    CHECK(graph.is_dag());
    CHECK(graph.character_count == 6);
    CHECK(graph.node_count() == 7);
    CHECK(graph.byte_offsets.size() == 7);
    CHECK(graph.byte_offsets.back() == text.size());
    CHECK(graph.dictionary_version == "2026.1");

    const auto* full_name =
        find_edge(graph, 0, 3, dataeng::EdgeKind::DictionaryName, "110000");
    const auto* short_alias =
        find_edge(graph, 0, 2, dataeng::EdgeKind::DictionaryAlias, "110000");
    CHECK(full_name != nullptr);
    CHECK(short_alias != nullptr);
    if (full_name != nullptr) {
        CHECK(full_name->text == "北京市");
        CHECK(full_name->surface == "北京市");
        CHECK(full_name->bytes.begin == 0);
        CHECK(full_name->bytes.end == 9);
        CHECK(full_name->level == dataeng::RegionLevel::City);
        CHECK(full_name->cost == 1);
        CHECK(graph.source_slice(full_name->span) == "北京市");
    }
    if (short_alias != nullptr) {
        CHECK(short_alias->text == "北京");
        CHECK(short_alias->surface == "北京");
        CHECK(short_alias->bytes.end == 6);
        CHECK(short_alias->cost == 2);
    }

    // District name and alias overlap too, and both remain independent edges.
    CHECK(find_edge(graph, 3, 6, dataeng::EdgeKind::DictionaryName, "110105"));
    CHECK(find_edge(graph, 3, 5, dataeng::EdgeKind::DictionaryAlias, "110105"));

    const auto paths = graph.top_paths(8);
    CHECK(!paths.empty());
    CHECK(paths.front().total_cost == 2);
    CHECK(paths.front().edges.size() == 2);
    CHECK(paths.front().dictionary_version == "2026.1");
    CHECK(paths.front().character_count == 6);
    for (const auto& path : paths) {
        check_path_shape(graph, path);
    }
}

void test_top_n_order_and_limits() {
    dataeng::AddressSegmenter segmenter(make_address_dictionary());
    const dataeng::CandidateGraph graph =
        segmenter.build_graph("北京市朝阳区");
    const auto paths = graph.top_paths(12);
    CHECK(!paths.empty());
    CHECK(paths.size() <= 12);

    for (std::size_t i = 1; i < paths.size(); ++i) {
        CHECK(paths[i - 1].total_cost <= paths[i].total_cost);
        if (paths[i - 1].total_cost == paths[i].total_cost) {
            CHECK(paths[i - 1].stable_key < paths[i].stable_key);
        }
    }
    CHECK(graph.top_paths(0).empty());
    CHECK(graph.top_paths(1).size() == 1);

    // Asking for more paths than exist must simply return all of them.
    dataeng::AdminDictionary tiny("v1");
    tiny.add("a", "甲");
    dataeng::AddressSegmenter tiny_segmenter(tiny);
    const auto tiny_paths = tiny_segmenter.top_paths("甲", 100);
    CHECK(tiny_paths.size() >= 2);  // dictionary edge and unknown fallback
}

void test_unknown_single_characters_and_runs() {
    dataeng::AdminDictionary dictionary("v2");
    dictionary.add("110000", "北京市", {}, dataeng::RegionLevel::City);
    dataeng::AddressSegmenter segmenter(dictionary);

    const std::string text = "北京市X区";
    const dataeng::CandidateGraph graph = segmenter.build_graph(text);
    CHECK(graph.character_count == 5);

    const auto* run =
        find_edge(graph, 3, 5, dataeng::EdgeKind::Unknown);
    CHECK(run != nullptr);
    if (run != nullptr) {
        CHECK(run->text == "X区");
        CHECK(run->bytes.begin == 9);
        CHECK(run->bytes.end == 13);
        CHECK(run->cost == 200);
        CHECK(run->entry_id.empty());
    }
    const auto* x = find_edge(graph, 3, 4, dataeng::EdgeKind::Unknown);
    const auto* district = find_edge(graph, 4, 5, dataeng::EdgeKind::Unknown);
    CHECK(x != nullptr);
    CHECK(district != nullptr);
    if (x != nullptr) {
        CHECK(x->text == "X");
        CHECK(x->cost == 100);
    }

    // The whole unknown run and the per-character fallback have equal cost.
    // Both are valid candidates and are kept.
    const auto paths = graph.top_paths(4);
    CHECK(paths.size() >= 2);
    CHECK(paths.front().total_cost == 201);
    bool saw_run_path = false;
    bool saw_chars_path = false;
    for (const auto& path : paths) {
        if (path.edges.size() == 2 && path.edges[1].span.begin == 3 &&
            path.edges[1].span.end == 5) {
            saw_run_path = true;
        }
        if (path.edges.size() == 3 && path.edges[1].span.begin == 3 &&
            path.edges[1].span.end == 4) {
            saw_chars_path = true;
        }
    }
    CHECK(saw_run_path);
    CHECK(saw_chars_path);
}

void test_overlapping_matches_still_allow_complete_paths() {
    dataeng::AdminDictionary dictionary("overlap-v1");
    dictionary
        .add("abc", "ABC", {}, dataeng::RegionLevel::Other)
        .add("bcd", "BCD", {}, dataeng::RegionLevel::Other);
    dataeng::AddressSegmenter segmenter(dictionary);
    const dataeng::CandidateGraph graph = segmenter.build_graph("ABCD");

    CHECK(graph.is_dag());
    CHECK(find_edge(graph, 0, 3, dataeng::EdgeKind::DictionaryName));
    CHECK(find_edge(graph, 1, 4, dataeng::EdgeKind::DictionaryName));
    const auto paths = graph.top_paths(10);
    CHECK(!paths.empty());
    CHECK(paths.front().total_cost == 101);
    for (const auto& path : paths) {
        check_path_shape(graph, path);
    }
}

void test_determinism_across_insertion_order() {
    dataeng::AdminDictionary forward("v3");
    forward
        .add("p", "省", {}, dataeng::RegionLevel::Province)
        .add("c", "市", {}, dataeng::RegionLevel::City)
        .add("d", "区", {}, dataeng::RegionLevel::District)
        .add("pc", "省市", {"省城"}, dataeng::RegionLevel::Province);

    dataeng::AdminDictionary reverse("v3");
    reverse
        .add("pc", "省市", {"省城"}, dataeng::RegionLevel::Province)
        .add("d", "区", {}, dataeng::RegionLevel::District)
        .add("c", "市", {}, dataeng::RegionLevel::City)
        .add("p", "省", {}, dataeng::RegionLevel::Province);

    dataeng::AddressSegmenter first(forward);
    dataeng::AddressSegmenter second(reverse);
    const auto first_paths = first.top_paths("省市城区", 15);
    const auto second_paths = second.top_paths("省市城区", 15);
    CHECK(first_paths.size() == second_paths.size());
    for (std::size_t i = 0; i < first_paths.size(); ++i) {
        CHECK(first_paths[i].total_cost == second_paths[i].total_cost);
        CHECK(first_paths[i].stable_key == second_paths[i].stable_key);
        CHECK(first_paths[i].edges.size() == second_paths[i].edges.size());
    }
}

void test_empty_input() {
    dataeng::AddressSegmenter segmenter(make_address_dictionary());
    const auto graph = segmenter.build_graph("");
    CHECK(graph.character_count == 0);
    CHECK(graph.edges.empty());
    CHECK(graph.is_dag());
    const auto paths = graph.top_paths(5);
    CHECK(paths.size() == 1);
    CHECK(paths.front().edges.empty());
    CHECK(paths.front().total_cost == 0);
    CHECK(paths.front().character_count == 0);
}

void test_validation_errors() {
    dataeng::AdminDictionary dictionary("v1");
    dictionary.add("id", "名称");
    bool duplicate_threw = false;
    try {
        dictionary.add("id", "另一个");
    } catch (const std::invalid_argument&) {
        duplicate_threw = true;
    }
    CHECK(duplicate_threw);

    bool empty_name_threw = false;
    try {
        dictionary.add("id2", "");
    } catch (const std::invalid_argument&) {
        empty_name_threw = true;
    }
    CHECK(empty_name_threw);

    bool negative_cost_threw = false;
    try {
        dictionary.add("id3", "名称", {}, dataeng::RegionLevel::Other, {}, -1);
    } catch (const std::invalid_argument&) {
        negative_cost_threw = true;
    }
    CHECK(negative_cost_threw);

    bool invalid_utf8_threw = false;
    try {
        dictionary.add("id4", std::string("\xFF", 1));
    } catch (const std::invalid_argument&) {
        invalid_utf8_threw = true;
    }
    CHECK(invalid_utf8_threw);

    dataeng::AddressSegmenter segmenter(dictionary);
    bool input_utf8_threw = false;
    try {
        (void)segmenter.build_graph(std::string_view("\xC0\xAF", 2));
    } catch (const std::invalid_argument&) {
        input_utf8_threw = true;
    }
    CHECK(input_utf8_threw);
}

void test_alias_and_version_metadata() {
    dataeng::AdminDictionary dictionary("2025.12");
    dictionary.add("110000", "北京市", {"北京", "京"}, dataeng::RegionLevel::City,
                   "", 3);
    dataeng::AddressSegmenter segmenter(dictionary);
    const auto graph = segmenter.build_graph("京");
    const auto* alias = find_edge(graph, 0, 1, dataeng::EdgeKind::DictionaryAlias,
                                  "110000");
    CHECK(alias != nullptr);
    if (alias != nullptr) {
        CHECK(alias->surface == "京");
        CHECK(alias->cost == 5);  // alias cost 2 + entry extra cost 3
        CHECK(alias->level == dataeng::RegionLevel::City);
        CHECK(alias->bytes.begin == 0);
        CHECK(alias->bytes.end == 3);
    }
    const auto paths = graph.top_paths(1);
    CHECK(paths.size() == 1);
    CHECK(paths.front().dictionary_version == "2025.12");
}

void test_find_and_accessors() {
    const auto dictionary = make_address_dictionary();
    CHECK(dictionary.size() == 2);
    CHECK(dictionary.contains("110000"));
    CHECK(!dictionary.contains("missing"));
    const auto* entry = dictionary.find("110105");
    CHECK(entry != nullptr);
    if (entry != nullptr) {
        CHECK(entry->name == "朝阳区");
        CHECK(entry->parent_id == "110000");
    }

    dataeng::AddressSegmenter segmenter(dictionary);
    CHECK(segmenter.dictionary().version() == "2026.1");
    CHECK(segmenter.options().unknown_char_cost == 100);
}

}  // namespace

int main() {
    test_utf8_spans_and_overlaps();
    test_top_n_order_and_limits();
    test_unknown_single_characters_and_runs();
    test_overlapping_matches_still_allow_complete_paths();
    test_determinism_across_insertion_order();
    test_empty_input();
    test_validation_errors();
    test_alias_and_version_metadata();
    test_find_and_accessors();

    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "all dataeng tests passed\n";
    return EXIT_SUCCESS;
}
