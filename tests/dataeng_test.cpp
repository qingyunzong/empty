#include "dataeng.hpp"

#include <cstdio>
#include <string>

static int failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__,     \
                         #cond);                                             \
            ++failures;                                                      \
        }                                                                    \
    } while (0)

static bool has_issue(const dataeng::ParseResult& r, const std::string& code) {
    for (const auto& issue : r.issues)
        if (issue.code == code)
            return true;
    return false;
}

static void test_basic_interchange() {
    const std::string edi =
        "UNB+UNOC:3+SENDER+RECEIVER+260116:1200+CTRL1'"
        "UNH+1+ORDERS:D:96A:UN'"
        "BGM+220+PO123'"
        "UNT+3+1'"
        "UNH+2+INVOIC:D:96A:UN'"
        "BGM+380+INV9'"
        "UNT+3+2'"
        "UNZ+2+CTRL1'";
    auto r = dataeng::parse_interchange(edi);
    CHECK(r.ok());
    CHECK(!r.interchange.used_una);
    CHECK(r.interchange.syntax_id == "UNOC");
    CHECK(r.interchange.syntax_version == "3");
    CHECK(r.interchange.sender_id == "SENDER");
    CHECK(r.interchange.control_ref == "CTRL1");
    CHECK(r.interchange.messages.size() == 2);
    CHECK(r.interchange.messages[0].type == "ORDERS");
    CHECK(r.interchange.messages[0].count_ok);
    CHECK(r.interchange.count_ok);
}

static void test_una_custom_delimiters() {
    // UNA: component=':' element='*' decimal=',' release='!' reserved=' '
    // terminator='#'
    const std::string edi =
        "UNA:*,! #"
        "UNB*UNOC:4*SND*RCV*260116:1200*CTRL2#"
        "UNH*1*DESADV:D:96A:UN#"
        "BGM*351*DES!*ADV1#" // released element separator inside data
        "UNT*3*1#"
        "UNZ*1*CTRL2#";
    auto r = dataeng::parse_interchange(edi);
    CHECK(r.ok());
    CHECK(r.interchange.used_una);
    CHECK(r.interchange.delimiters.element == '*');
    CHECK(r.interchange.delimiters.terminator == '#');
    CHECK(r.interchange.messages.size() == 1);
    CHECK(r.interchange.messages[0].segments[1].elements[1][0] == "DES*ADV1");
    CHECK(r.interchange.count_ok);
}

static void test_groups() {
    const std::string edi =
        "UNB+UNOC:3+SND+RCV+260116:1200+CTRL3'"
        "UNG+INVOIC+SND+RCV+260116:1200+G1+UN+D:96A'"
        "UNH+1+INVOIC:D:96A:UN'"
        "BGM+380+I1'"
        "UNT+3+1'"
        "UNH+2+INVOIC:D:96A:UN'"
        "BGM+380+I2'"
        "UNT+3+2'"
        "UNE+2+G1'"
        "UNZ+1+CTRL3'";
    auto r = dataeng::parse_interchange(edi);
    CHECK(r.ok());
    CHECK(r.interchange.groups.size() == 1);
    CHECK(r.interchange.groups[0].messages.size() == 2);
    CHECK(r.interchange.groups[0].count_ok);
    CHECK(r.interchange.count_ok); // UNZ counts groups when grouping used
}

static void test_bad_message_isolated_counts_reconciled() {
    // Second message has a wrong UNT count; it must be isolated while
    // the group and interchange counts still reconcile.
    const std::string edi =
        "UNB+UNOC:3+SND+RCV+260116:1200+CTRL4'"
        "UNG+INVOIC+SND+RCV+260116:1200+G1+UN+D:96A'"
        "UNH+1+INVOIC:D:96A:UN'"
        "BGM+380+I1'"
        "UNT+3+1'"
        "UNH+2+INVOIC:D:96A:UN'"
        "BGM+380+I2'"
        "UNT+9+2'"
        "UNE+2+G1'"
        "UNZ+1+CTRL4'";
    auto r = dataeng::parse_interchange(edi);
    CHECK(has_issue(r, "UNT_COUNT_MISMATCH"));
    const auto& group = r.interchange.groups[0];
    CHECK(group.messages.size() == 2);
    CHECK(!group.messages[0].isolated);
    CHECK(group.messages[1].isolated);
    CHECK(group.count_ok);        // UNE count still reconciles
    CHECK(r.interchange.count_ok); // UNZ count still reconciles
}

static void test_unz_count_mismatch() {
    const std::string edi =
        "UNB+UNOC:3+SND+RCV+260116:1200+CTRL5'"
        "UNH+1+ORDERS:D:96A:UN'"
        "BGM+220+PO1'"
        "UNT+3+1'"
        "UNZ+5+CTRL5'";
    auto r = dataeng::parse_interchange(edi);
    CHECK(has_issue(r, "UNZ_COUNT_MISMATCH"));
    CHECK(!r.interchange.count_ok);
}

static void test_missing_unt_isolated() {
    const std::string edi =
        "UNB+UNOC:3+SND+RCV+260116:1200+CTRL6'"
        "UNH+1+ORDERS:D:96A:UN'"
        "BGM+220+PO1'"
        "UNH+2+ORDERS:D:96A:UN'"
        "BGM+220+PO2'"
        "UNT+3+2'"
        "UNZ+2+CTRL6'";
    auto r = dataeng::parse_interchange(edi);
    CHECK(has_issue(r, "UNT_MISSING"));
    CHECK(r.interchange.messages.size() == 2);
    CHECK(r.interchange.messages[0].isolated);
    CHECK(!r.interchange.messages[1].isolated);
    CHECK(r.interchange.count_ok);
}

static void test_dedup() {
    const std::string edi =
        "UNB+UNOC:3+SND+RCV+260116:1200+CTRL7'"
        "UNH+1+ORDERS:D:96A:UN'"
        "BGM+220+PO1'"
        "UNT+3+1'"
        "UNZ+1+CTRL7'";
    auto first = dataeng::parse_interchange(edi);
    auto again = dataeng::parse_interchange(edi);
    const std::string changed =
        "UNB+UNOC:3+SND+RCV+260116:1200+CTRL7'"
        "UNH+1+ORDERS:D:96A:UN'"
        "BGM+220+PO999'"
        "UNT+3+1'"
        "UNZ+1+CTRL7'";
    auto conflict = dataeng::parse_interchange(changed);
    // Same control number but a different sender is a distinct key.
    const std::string other_sender =
        "UNB+UNOC:3+OTHER+RCV+260116:1200+CTRL7'"
        "UNH+1+ORDERS:D:96A:UN'"
        "BGM+220+PO1'"
        "UNT+3+1'"
        "UNZ+1+CTRL7'";
    auto other = dataeng::parse_interchange(other_sender);

    dataeng::InterchangeRegistry registry;
    CHECK(registry.submit(first.interchange).status ==
          dataeng::DedupStatus::Accepted);
    CHECK(registry.submit(again.interchange).status ==
          dataeng::DedupStatus::Duplicate);
    CHECK(registry.submit(conflict.interchange).status ==
          dataeng::DedupStatus::Conflict);
    CHECK(registry.submit(other.interchange).status ==
          dataeng::DedupStatus::Accepted);
    CHECK(registry.size() == 2);
}

int main() {
    test_basic_interchange();
    test_una_custom_delimiters();
    test_groups();
    test_bad_message_isolated_counts_reconciled();
    test_unz_count_mismatch();
    test_missing_unt_isolated();
    test_dedup();
    if (failures == 0)
        std::puts("all tests passed");
    return failures == 0 ? 0 : 1;
}
