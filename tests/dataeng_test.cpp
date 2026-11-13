#include "dataeng.hpp"

#include <cstdlib>
#include <iostream>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace {

int failures = 0;

void check(bool condition, std::string_view message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << "\n";
        ++failures;
    }
}

std::string field(std::string_view value, std::size_t width) {
    std::string result(value);
    if (result.size() < width) {
        result.resize(width, ' ');
    }
    return result;
}

std::string make_isa(std::string_view sender = "SENDER",
                     std::string_view control = "000000001",
                     char element = '*', char repetition = '^',
                     char component = ':', char terminator = '~') {
    std::string result = "ISA";
    result += element;
    result += "00";
    result += element;
    result += field("", 10);
    result += element;
    result += "00";
    result += element;
    result += field("", 10);
    result += element;
    result += "ZZ";
    result += element;
    result += field(sender, 15);
    result += element;
    result += "ZZ";
    result += element;
    result += field("RECEIVER", 15);
    result += element;
    result += "250101";
    result += element;
    result += "1200";
    result += element;
    result += repetition;
    result += element;
    result += "00501";
    result += element;
    result += field(control, 9);
    result += element;
    result += "0";
    result += element;
    result += "P";
    result += element;
    result += component;
    result += terminator;
    return result;
}

std::string valid_interchange(std::string_view control = "000000001",
                              std::string_view group_control = "7") {
    std::string result = make_isa("SENDER", control);
    result += "GS*PO*SENDER*RECEIVER*20250101*1200*" +
              std::string(group_control) + "*X*005010~";
    result += "ST*850*0001~";
    result += "BEG*00*NE*123**20250101~";
    result += "SE*3*0001~";
    result += "ST*856*0002~";
    result += "BSN*00*ABC~";
    result += "SE*3*0002~";
    result += "GE*2*" + std::string(group_control) + "~";
    result += "IEA*1*" + std::string(control) + "~";
    return result;
}

bool has_code(const dataeng::ParseResult& result, std::string_view code) {
    for (const auto& diagnostic : result.diagnostics) {
        if (diagnostic.code == code) {
            return true;
        }
    }
    return false;
}

void test_valid_and_chunked() {
    const std::string input = valid_interchange();
    auto whole = dataeng::parse(input);
    check(whole.ok(), "valid interchange should parse without errors");
    check(whole.interchanges.size() == 1, "one interchange expected");
    check(whole.duplicates.empty(), "no duplicate expected");
    if (whole.interchanges.size() != 1) {
        return;
    }
    const auto& interchange = whole.interchanges.front();
    check(interchange.complete, "interchange should be complete");
    check(interchange.valid, "interchange should be valid");
    check(interchange.envelope_valid, "interchange envelope should be valid");
    check(interchange.declared_group_count == 1, "IEA01 should be 1");
    check(interchange.actual_group_count == 1, "one group expected");
    check(interchange.groups.size() == 1, "one group result expected");
    if (interchange.groups.size() != 1) {
        return;
    }
    const auto& group = interchange.groups.front();
    check(group.complete && group.valid, "group should be valid");
    check(group.declared_transaction_count == 2, "GE01 should be 2");
    check(group.actual_transaction_count == 2, "two transactions expected");
    check(group.transactions.size() == 2, "two transaction results expected");
    for (const auto& transaction : group.transactions) {
        check(transaction.complete && transaction.valid,
              "transaction should be valid");
        check(transaction.declared_segment_count ==
                  transaction.actual_segment_count,
              "transaction segment counts should match");
    }
    check(whole.delimiters.size() == 1, "derived delimiters expected");
    if (!whole.delimiters.empty()) {
        check(whole.delimiters.front().element == '*', "element delimiter");
        check(whole.delimiters.front().repetition == '^', "repetition delimiter");
        check(whole.delimiters.front().component == ':', "component delimiter");
        check(whole.delimiters.front().segment == '~', "segment delimiter");
    }

    dataeng::EnvelopeStateMachine machine;
    for (std::size_t offset = 0; offset < input.size();) {
        const std::size_t chunk = 1 + (offset % 11);
        machine.feed(std::string_view(input).substr(offset, chunk));
        offset += chunk;
    }
    machine.finish();
    const auto& chunked = machine.result();
    check(chunked.ok(), "chunked parse should have no errors");
    check(chunked.interchanges.size() == 1, "chunked interchange expected");
    if (chunked.interchanges.size() == 1) {
        check(chunked.interchanges.front().groups.size() == 1,
              "chunked group expected");
        if (chunked.interchanges.front().groups.size() == 1) {
            check(chunked.interchanges.front()
                          .groups.front()
                          .transactions.size() == 2,
                  "chunked transactions expected");
        }
    }
}

void test_group_crosses_chunks() {
    const std::string input = valid_interchange("000000009", "42");
    dataeng::EnvelopeStateMachine machine;
    const std::size_t split = input.find("ST*856");
    check(split != std::string::npos, "second transaction marker expected");
    machine.feed(std::string_view(input).substr(0, split));
    machine.feed(std::string_view(input).substr(split, 5));
    machine.feed(std::string_view(input).substr(split + 5));
    machine.finish();
    const auto& result = machine.result();
    check(result.ok(), "split group should parse without errors");
    check(result.interchanges.size() == 1, "split group interchange expected");
    if (result.interchanges.size() == 1 &&
        result.interchanges.front().groups.size() == 1) {
        check(result.interchanges.front().groups.front().transactions.size() ==
                  2,
              "split group should retain both transactions");
    }
}

void test_duplicate_interchange() {
    const std::string input =
        valid_interchange("000000001", "7") +
        valid_interchange("000000001", "7");
    const auto result = dataeng::parse(input);
    check(result.interchanges.size() == 1,
          "duplicate interchange should be deduplicated");
    check(result.duplicates.size() == 1, "one duplicate interchange expected");
    check(result.ok(), "duplicate detection should not be an error");
    if (result.duplicates.size() == 1) {
        check(result.duplicates.front().duplicate,
              "duplicate flag should be set");
        check(!result.duplicates.front().accepted,
              "duplicate should not be accepted");
        check(result.duplicates.front().groups.empty(),
              "duplicate payload should not be reprocessed");
    }
}

void test_hierarchical_errors_are_not_masked() {
    std::string input = make_isa("SENDER", "000000001");
    input += "GS*PO*SENDER*RECEIVER*20250101*1200*7*X*005010~";
    input += "ST*850*0001~";
    input += "BEG*00*NE*123**20250101~";
    input += "SE*4*9999~";
    input += "GE*2*8~";
    input += "IEA*2*000000999~";

    const auto result = dataeng::parse(input);
    check(has_code(result, "TRANSACTION_SEGMENT_COUNT_MISMATCH"),
          "SE01 mismatch should be reported");
    check(has_code(result, "TRANSACTION_CONTROL_MISMATCH"),
          "SE02 mismatch should be reported");
    check(has_code(result, "GROUP_TRANSACTION_COUNT_MISMATCH"),
          "GE01 mismatch should be reported");
    check(has_code(result, "GROUP_CONTROL_MISMATCH"),
          "GE02 mismatch should be reported");
    check(has_code(result, "INTERCHANGE_GROUP_COUNT_MISMATCH"),
          "IEA01 mismatch should be reported");
    check(has_code(result, "INTERCHANGE_CONTROL_MISMATCH"),
          "IEA02 mismatch should be reported");
    check(result.interchanges.size() == 1,
          "envelope errors should not discard the interchange");
    check(!result.ok(), "mismatches should make the result invalid");
    if (result.interchanges.size() == 1) {
        const auto& interchange = result.interchanges.front();
        check(!interchange.valid, "interchange should be invalid");
        check(!interchange.envelope_valid,
              "IEA errors should invalidate the interchange envelope");
        check(interchange.groups.size() == 1,
              "group should survive transaction errors");
        if (interchange.groups.size() == 1) {
            check(!interchange.groups.front().valid,
                  "group should be invalid when its transaction fails");
            check(interchange.groups.front().transactions.size() == 1,
                  "transaction evidence should be retained");
        }
    }
}

void test_missing_se_does_not_hide_envelope() {
    std::string input = make_isa("SENDER", "000000001");
    input += "GS*PO*SENDER*RECEIVER*20250101*1200*7*X*005010~";
    input += "ST*850*0001~";
    input += "BEG*00*NE*123**20250101~";
    input += "GE*1*7~";
    input += "IEA*1*000000001~";

    const auto result = dataeng::parse(input);
    check(has_code(result, "TRANSACTION_UNCLOSED"),
          "missing SE should be reported");
    check(!has_code(result, "INTERCHANGE_CONTROL_MISMATCH"),
          "valid IEA control should not be invented");
    check(has_code(result, "GROUP_TRANSACTION_COUNT_MISMATCH") == false,
          "GE count should still match observed transaction");
    if (result.interchanges.size() == 1) {
        const auto& interchange = result.interchanges.front();
        check(interchange.envelope_valid,
              "local transaction failure must not mask a valid interchange "
              "envelope");
        check(!interchange.valid,
              "overall interchange validity should include nested failures");
        check(interchange.groups.size() == 1,
              "group should remain in evidence");
        if (interchange.groups.size() == 1) {
            check(interchange.groups.front().envelope_valid,
                  "group envelope should still be valid");
            check(!interchange.groups.front().valid,
                  "group should be invalid because transaction failed");
        }
    }
}

void test_custom_delimiters_and_multiple_groups() {
    std::string input = make_isa("SENDER", "000000123", '|', '^', ':', '!');
    input += "GS|PO|SENDER|RECEIVER|20250101|1200|A|X|005010!";
    input += "ST|850|0001!";
    input += "BEG|00|NE|123!";
    input += "SE|3|0001!";
    input += "GE|1|A!";
    input += "GS|IN|SENDER|RECEIVER|20250101|1200|B|X|005010!";
    input += "ST|810|0002!";
    input += "BIG|20250101|INV1!";
    input += "SE|3|0002!";
    input += "GE|1|B!";
    input += "IEA|2|000000123!";

    const auto result = dataeng::parse(input);
    check(result.ok(), "custom delimiters and two groups should parse");
    check(result.interchanges.size() == 1, "one custom-delimiter interchange");
    if (result.interchanges.size() == 1) {
        check(result.interchanges.front().groups.size() == 2,
              "two custom-delimiter groups expected");
        if (!result.delimiters.empty()) {
            check(result.delimiters.front().element == '|',
                  "custom element delimiter should be derived");
            check(result.delimiters.front().component == ':',
                  "custom component delimiter should be derived");
            check(result.delimiters.front().segment == '!',
                  "custom segment delimiter should be derived");
        }
    }
}

void test_old_style_repetition_byte() {
    const std::string input =
        make_isa("SENDER", "000000001", '*', 'U', ':', '~') +
        "GS*PO*SENDER*RECEIVER*20250101*1200*7*X*005010~"
        "ST*850*0001~SE*2*0001~GE*1*7~IEA*1*000000001~";
    const auto result = dataeng::parse(input);
    check(result.ok(), "an ISA11 standards byte should still be parseable");
}

void test_json_keeps_hierarchy() {
    const auto result = dataeng::parse(valid_interchange());
    const std::string json = result.to_json();
    check(json.find("\"interchanges\"") != std::string::npos,
          "JSON should expose interchanges");
    check(json.find("\"groups\"") != std::string::npos,
          "JSON should expose groups");
    check(json.find("\"transactions\"") != std::string::npos,
          "JSON should expose transactions");
    check(json.find("\"diagnostics\"") != std::string::npos,
          "JSON should expose diagnostics");
    check(json.find("\"delimiters\"") != std::string::npos,
          "JSON should expose derived delimiters");
}

void test_multiple_interchanges_and_different_delimiters() {
    std::string input = valid_interchange("000000001", "7");
    input += make_isa("OTHER", "000000002", '|', '^', ':', '!');
    input += "GS|PO|OTHER|RECEIVER|20250101|1200|8|X|005010!";
    input += "ST|850|0003!";
    input += "SE|2|0003!";
    input += "GE|1|8!";
    input += "IEA|1|000000002!";

    const auto result = dataeng::parse(input);
    check(result.ok(), "multiple interchanges should parse cleanly");
    check(result.interchanges.size() == 2, "two interchanges expected");
    check(result.delimiters.size() == 2,
          "both interchange delimiter sets should be reported");
    if (result.interchanges.size() == 2) {
        check(result.interchanges[0].sender_id == "SENDER",
              "first interchange sender");
        check(result.interchanges[1].sender_id == "OTHER",
              "second interchange sender");
        check(result.interchanges[1].groups.size() == 1,
              "second interchange group expected");
    }
}

void test_new_isa_closes_unfinished_envelopes() {
    std::string input = make_isa("SENDER", "000000001");
    input += "GS*PO*SENDER*RECEIVER*20250101*1200*7*X*005010~";
    input += "ST*850*0001~";
    input += "BEG*00*NE*123~";
    input += valid_interchange("000000002", "8");

    const auto result = dataeng::parse(input);
    check(result.interchanges.size() == 2,
          "a new ISA should recover from unfinished envelopes");
    check(has_code(result, "TRANSACTION_UNCLOSED"),
          "missing SE before new ISA should be reported");
    check(has_code(result, "GROUP_UNCLOSED"),
          "missing GE before new ISA should be reported");
    check(has_code(result, "INTERCHANGE_UNCLOSED"),
          "missing IEA before new ISA should be reported");
    if (result.interchanges.size() == 2) {
        check(!result.interchanges[0].valid,
              "the unfinished interchange should be invalid");
        check(result.interchanges[1].valid,
              "the following interchange should still be valid");
    }
}

void test_isa_layout_evidence() {
    std::string input = valid_interchange();
    input[6] = '#';
    const auto result = dataeng::parse(input);
    check(has_code(result, "ISA_LAYOUT_INVALID"),
          "non-fixed ISA layout should be reported");
    if (!result.diagnostics.empty()) {
        bool found = false;
        for (const auto& diagnostic : result.diagnostics) {
            if (diagnostic.code == "ISA_LAYOUT_INVALID") {
                found = diagnostic.level == dataeng::Level::interchange &&
                        diagnostic.segment_id == "ISA" &&
                        diagnostic.location.byte_offset == 0;
            }
        }
        check(found, "ISA evidence should carry interchange-level location");
    }
}

std::string control_number(std::size_t value) {
    std::string result = std::to_string(value);
    if (result.size() < 9) {
        result.insert(result.begin(), 9 - result.size(), '0');
    }
    return result;
}

void test_compaction_and_streaming_many_interchanges() {
    std::string input;
    constexpr std::size_t interchange_count = 120;
    for (std::size_t index = 0; index < interchange_count; ++index) {
        input += valid_interchange(control_number(index + 1),
                                   std::to_string(index + 1));
    }

    dataeng::EnvelopeStateMachine machine;
    for (std::size_t offset = 0; offset < input.size(); offset += 37) {
        machine.feed(std::string_view(input).substr(offset, 37));
    }
    machine.finish();

    check(machine.result().ok(), "many streamed interchanges should be valid");
    check(machine.result().interchanges.size() == interchange_count,
          "all streamed interchanges should be retained");
    check(machine.result().duplicates.empty(),
          "unique sender+control values should not be deduplicated");
}

}  // namespace

int main() {
    test_valid_and_chunked();
    test_group_crosses_chunks();
    test_duplicate_interchange();
    test_hierarchical_errors_are_not_masked();
    test_missing_se_does_not_hide_envelope();
    test_custom_delimiters_and_multiple_groups();
    test_old_style_repetition_byte();
    test_json_keeps_hierarchy();
    test_multiple_interchanges_and_different_delimiters();
    test_new_isa_closes_unfinished_envelopes();
    test_isa_layout_evidence();
    test_compaction_and_streaming_many_interchanges();

    if (failures != 0) {
        std::cerr << failures << " test(s) failed\n";
        return EXIT_FAILURE;
    }
    std::cout << "all tests passed\n";
    return EXIT_SUCCESS;
}
