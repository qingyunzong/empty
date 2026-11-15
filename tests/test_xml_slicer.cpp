#include "xml_slicer.hpp"

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <random>
#include <string>
#include <string_view>

using namespace dataeng::xml;

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        ++g_checks;                                                          \
        if (!(cond)) {                                                       \
            ++g_failures;                                                    \
            std::cerr << "FAIL: " #cond " at " << __FILE__ << ':'           \
                      << __LINE__ << '\n';                                   \
        }                                                                    \
    } while (0)

bool feed_all(XmlSlicer& slicer, std::string_view doc, std::size_t chunk) {
    bool ok = true;
    for (std::size_t i = 0; i < doc.size(); i += chunk) {
        ok = slicer.feed(doc.data() + i, std::min(chunk, doc.size() - i)) && ok;
    }
    return slicer.finish() && ok;
}

void test_basic_slice() {
    XmlSlicer slicer({.target_paths = {"/root/item"}});
    std::string doc =
        "<root><item id=\"1\">a</item><other>x</other><item id=\"2\">b</item></root>";
    CHECK(feed_all(slicer, doc, 1024));
    auto slices = slicer.take_slices();
    CHECK(slices.size() == 2);
    CHECK(slices[0].raw == "<item id=\"1\">a</item>");
    CHECK(slices[1].raw == "<item id=\"2\">b</item>");
    CHECK(slices[0].path == "/root/item");
    CHECK(doc.substr(slices[0].start_offset,
                     slices[0].end_offset - slices[0].start_offset) == slices[0].raw);
    CHECK(doc.substr(slices[1].start_offset,
                     slices[1].end_offset - slices[1].start_offset) == slices[1].raw);
    CHECK(slicer.unclosed().empty());
}

void test_split_tokens() {
    XmlSlicer slicer({.target_paths = {"/root/item"}});
    std::string doc = "<root><item>split</item></root>";
    for (std::size_t chunk = 1; chunk <= 7; ++chunk) {
        XmlSlicer s({.target_paths = {"/root/item"}});
        CHECK(feed_all(s, doc, chunk));
        auto slices = s.take_slices();
        CHECK(slices.size() == 1);
        CHECK(slices[0].raw == "<item>split</item>");
    }
}

void test_entity_split_at_ampersand() {
    XmlSlicer slicer({.target_paths = {"/r/e"}});
    std::string doc =
        "<!DOCTYPE r [<!ENTITY greeting \"hello\"><!ENTITY who \"world\">]>"
        "<r><e>&greeting; &who;!</e></r>";
    for (std::size_t chunk = 1; chunk <= 5; ++chunk) {
        XmlSlicer s({.target_paths = {"/r/e"}});
        CHECK(feed_all(s, doc, chunk));
        auto slices = s.take_slices();
        CHECK(slices.size() == 1);
        CHECK(slices[0].raw == "<e>&greeting; &who;!</e>");
    }
}

void test_cdata_preserves_raw() {
    XmlSlicer slicer({.target_paths = {"/r/e"}});
    std::string doc = "<r><e>text<![CDATA[<not a tag> & raw]]></e></r>";
    CHECK(feed_all(slicer, doc, 4));
    auto slices = slicer.take_slices();
    CHECK(slices.size() == 1);
    CHECK(slices[0].raw == "<e>text<![CDATA[<not a tag> & raw]]></e>");
}

void test_namespaces() {
    XmlSlicer slicer({.target_paths = {"/{urn:a}doc/{urn:b}record"}});
    std::string doc =
        "<a:doc xmlns:a=\"urn:a\" xmlns:b=\"urn:b\">"
        "<b:record n=\"1\"/><b:record n=\"2\"/>"
        "<other xmlns=\"urn:c\"/>"
        "</a:doc>";
    CHECK(feed_all(slicer, doc, 3));
    auto slices = slicer.take_slices();
    CHECK(slices.size() == 2);
    CHECK(slices[0].raw == "<b:record n=\"1\"/>");
    CHECK(slices[0].path == "/{urn:a}doc/{urn:b}record");
}

void test_default_namespace_and_wildcard() {
    XmlSlicer slicer({.target_paths = {"/{urn:x}root/*"}});
    std::string doc =
        "<root xmlns=\"urn:x\"><a>1</a><b xmlns=\"\">2</b><c>3</c></root>";
    CHECK(feed_all(slicer, doc, 1024));
    auto slices = slicer.take_slices();
    CHECK(slices.size() == 3);
    CHECK(slices[0].path == "/{urn:x}root/{urn:x}a");
    CHECK(slices[1].path == "/{urn:x}root/b");
    CHECK(slices[2].path == "/{urn:x}root/{urn:x}c");
}

void test_nested_slices() {
    XmlSlicer slicer({.target_paths = {"/r/outer", "/r/outer/inner"}});
    std::string doc = "<r><outer>a<inner>deep</inner>b</outer></r>";
    CHECK(feed_all(slicer, doc, 2));
    auto slices = slicer.take_slices();
    CHECK(slices.size() == 2);
    CHECK(slices[0].path == "/r/outer/inner");
    CHECK(slices[0].raw == "<inner>deep</inner>");
    CHECK(slices[1].path == "/r/outer");
    CHECK(slices[1].raw == "<outer>a<inner>deep</inner>b</outer>");
}

void test_external_entities_rejected() {
    {
        XmlSlicer slicer({.target_paths = {"/r"}});
        std::string doc =
            "<!DOCTYPE r [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><r>&xxe;</r>";
        CHECK(!feed_all(slicer, doc, 1024));
        CHECK(slicer.error().code == ErrorCode::ExternalEntity);
    }
    {
        XmlSlicer slicer({.target_paths = {"/r"}});
        std::string doc = "<!DOCTYPE r SYSTEM \"http://example.invalid/dtd\"><r/>";
        CHECK(!feed_all(slicer, doc, 1024));
        CHECK(slicer.error().code == ErrorCode::ExternalEntity);
    }
    {
        XmlSlicer slicer({.target_paths = {"/r"}});
        std::string doc =
            "<!DOCTYPE r [<!ENTITY % pe SYSTEM \"http://x/y\"><!ENTITY c \"%pe;\">]><r/>";
        CHECK(!feed_all(slicer, doc, 1024));
        CHECK(slicer.error().code == ErrorCode::ExternalEntity);
    }
}

void test_internal_entities_and_char_refs() {
    XmlSlicer slicer({.target_paths = {"/r/e"}});
    std::string doc =
        "<!DOCTYPE r [<!ENTITY a \"x\"><!ENTITY b \"&a;&a;\">]>"
        "<r><e v=\"&b;\" t=\"&#65;&#x42;\">&b;&#169;</e></r>";
    CHECK(feed_all(slicer, doc, 5));
    auto slices = slicer.take_slices();
    CHECK(slices.size() == 1);
    CHECK(slices[0].raw.find("&b;") != std::string::npos);
    CHECK(slicer.entity_expansion_used() == 12);
}

void test_undefined_entity() {
    XmlSlicer slicer({.target_paths = {"/r"}});
    CHECK(!feed_all(slicer, "<r>&missing;</r>", 1024));
    CHECK(slicer.error().code == ErrorCode::UndefinedEntity);
}

void test_billion_laughs_budget() {
    XmlSlicer slicer({.target_paths = {"/r/e",}, .entity_expansion_budget = 256});
    std::string doc =
        "<!DOCTYPE r ["
        "<!ENTITY a \"aaaaaaaaaa\">"
        "<!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;\">"
        "<!ENTITY c \"&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;\">"
        "]><r><e>&c;&c;&c;</e></r>";
    CHECK(!feed_all(slicer, doc, 7));
    CHECK(slicer.error().code == ErrorCode::EntityBudgetExceeded);
}

void test_recursive_entities() {
    XmlSlicer slicer({.target_paths = {"/r"}});
    std::string doc =
        "<!DOCTYPE r [<!ENTITY x \"&y;\"><!ENTITY y \"&x;\">]><r>&x;</r>";
    CHECK(!feed_all(slicer, doc, 1024));
    CHECK(slicer.error().code == ErrorCode::EntityRecursion);
}

void test_unclosed_keeps_completed_siblings() {
    XmlSlicer slicer({.target_paths = {"/root/item"}});
    std::string doc =
        "<root><item>one</item><item>two<child>still open</item>";
    CHECK(feed_all(slicer, doc, 3) == false);
    CHECK(slicer.error().code == ErrorCode::Malformed);
    auto slices = slicer.take_slices();
    CHECK(slices.size() == 1);
    CHECK(slices[0].raw == "<item>one</item>");

    XmlSlicer slicer2({.target_paths = {"/root/item"}});
    std::string doc2 = "<root><item>one</item><item>two";
    CHECK(slicer2.feed(doc2));
    CHECK(slicer2.finish());
    auto slices2 = slicer2.take_slices();
    CHECK(slices2.size() == 1);
    CHECK(slices2[0].raw == "<item>one</item>");
    CHECK(slicer2.unclosed().size() == 2);
    CHECK(slicer2.unclosed()[0].qname == "root");
    CHECK(slicer2.unclosed()[1].qname == "item");
    CHECK(slicer2.unclosed()[1].start_offset ==
          doc2.find("<item>two"));
    CHECK(slicer2.unclosed()[0].start_offset == 0);
}

void test_self_closing_and_pi_comments() {
    XmlSlicer slicer({.target_paths = {"/r/e"}});
    std::string doc =
        "<?xml version=\"1.0\"?><!-- header --><r><?app do?><e/><!-- c --></r>";
    CHECK(feed_all(slicer, doc, 6));
    auto slices = slicer.take_slices();
    CHECK(slices.size() == 1);
    CHECK(slices[0].raw == "<e/>");
}

void test_mismatched_tag() {
    XmlSlicer slicer({.target_paths = {"/r"}});
    CHECK(!feed_all(slicer, "<r><a></b></r>", 1024));
    CHECK(slicer.error().code == ErrorCode::Malformed);
}

void test_well_formedness_rules() {
    {
        XmlSlicer slicer({.target_paths = {"/r"}});
        CHECK(!feed_all(slicer, "<r><!----></r>", 1024));
        CHECK(slicer.error().code == ErrorCode::Malformed);
    }
    {
        XmlSlicer slicer({.target_paths = {"/r/e"}});
        CHECK(!feed_all(slicer, "<r><e>]]></e></r>", 1024));
        CHECK(slicer.error().code == ErrorCode::Malformed);
    }
    {
        XmlSlicer slicer({.target_paths = {"/r"}});
        CHECK(!feed_all(slicer, "<r>&</r>", 1024));
        CHECK(slicer.error().code == ErrorCode::Malformed);
    }
    {
        XmlSlicer slicer({.target_paths = {"/r/e"}});
        std::string doc = "<r><e>ok <![CDATA[ raw ]] > text ]]></e></r>";
        CHECK(feed_all(slicer, doc, 3));
        CHECK(slicer.take_slices().size() == 1);
    }
}

void test_encoding_restriction() {
    XmlSlicer slicer({.target_paths = {"/r"}});
    CHECK(!feed_all(slicer, "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><r/>", 1024));
    CHECK(slicer.error().code == ErrorCode::EncodingNotSupported);
}

void test_random_chunk_fuzz() {
    std::mt19937 rng(42);
    std::string doc =
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<!DOCTYPE r [<!ENTITY g \"hello\"><!ENTITY gg \"&g; &g;\">]>"
        "<r xmlns=\"urn:default\" xmlns:k=\"urn:k\">"
        "<!-- c --><k:e id=\"1\">a &gg; b<![CDATA[<&>]]></k:e>"
        "<k:e id=\"2\"/><k:e>tail</k:e></r>";
    std::uniform_int_distribution<std::size_t> dist(1, 13);
    for (int trial = 0; trial < 40; ++trial) {
        XmlSlicer slicer({.target_paths = {"/{urn:default}r/{urn:k}e"}});
        std::size_t i = 0;
        bool ok = true;
        while (i < doc.size()) {
            std::size_t n = std::min(dist(rng), doc.size() - i);
            ok = slicer.feed(doc.data() + i, n) && ok;
            i += n;
        }
        ok = slicer.finish() && ok;
        CHECK(ok);
        auto slices = slicer.take_slices();
        CHECK(slices.size() == 3);
        CHECK(slices[0].raw.find("&gg;") != std::string::npos);
        CHECK(slices[1].raw == "<k:e id=\"2\"/>");
        for (const auto& s : slices) {
            CHECK(doc.substr(s.start_offset, s.end_offset - s.start_offset) == s.raw);
        }
    }
}

void test_edge_cases() {
    {
        XmlSlicer slicer({.target_paths = {"/a"}});
        CHECK(slicer.feed("   "));
        CHECK(slicer.finish());
        CHECK(slicer.take_slices().empty());
        CHECK(slicer.unclosed().empty());
    }
    {
        std::string doc = "<r>";
        for (int i = 0; i < 200; ++i) {
            doc += "<e>" + std::to_string(i) + "</e>";
        }
        doc += "</r>";
        for (std::size_t chunk = 1; chunk <= 7; chunk += 2) {
            XmlSlicer slicer({.target_paths = {"/r/e"}});
            CHECK(feed_all(slicer, doc, chunk));
            auto slices = slicer.take_slices();
            CHECK(slices.size() == 200);
            for (const auto& s : slices) {
                CHECK(doc.substr(s.start_offset, s.end_offset - s.start_offset) == s.raw);
            }
        }
    }
    {
        XmlSlicer slicer({.target_paths = {"/r/e"}});
        std::string doc = "<r><e a='&apos;' b=\"&quot;\">x</e></r>";
        CHECK(slicer.feed(doc));
        CHECK(slicer.finish());
        auto slices = slicer.take_slices();
        CHECK(slices.size() == 1);
        CHECK(slices[0].start_offset == 3);
    }
    {
        XmlSlicer slicer({.target_paths = {"/r"}});
        CHECK(slicer.feed("<r><!ENTITY foo \"bar\"></r>"));
        CHECK(!slicer.finish());
        CHECK(slicer.error().code == ErrorCode::Malformed);
    }
    {
        XmlSlicer slicer({.target_paths = {"/r"}});
        CHECK(!slicer.feed("<r><a></b></r>"));
        CHECK(slicer.error().code == ErrorCode::Malformed);
        CHECK(!slicer.feed("<more/>"));
    }
}

}  // namespace

int main() {
    test_basic_slice();
    test_split_tokens();
    test_entity_split_at_ampersand();
    test_cdata_preserves_raw();
    test_namespaces();
    test_default_namespace_and_wildcard();
    test_nested_slices();
    test_external_entities_rejected();
    test_internal_entities_and_char_refs();
    test_undefined_entity();
    test_billion_laughs_budget();
    test_recursive_entities();
    test_unclosed_keeps_completed_siblings();
    test_self_closing_and_pi_comments();
    test_mismatched_tag();
    test_encoding_restriction();
    test_random_chunk_fuzz();
    test_edge_cases();
    test_well_formedness_rules();

    std::cout << (g_failures == 0 ? "ALL PASS" : "FAILURES") << " (" << g_checks
              << " checks, " << g_failures << " failed)\n";
    return g_failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
