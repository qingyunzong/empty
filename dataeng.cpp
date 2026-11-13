#include "dataeng.hpp"

#include <algorithm>
#include <charconv>
#include <cctype>
#include <limits>
#include <sstream>
#include <utility>

namespace {

using dataeng::Diagnostic;
using dataeng::FunctionalGroup;
using dataeng::Interchange;
using dataeng::Level;
using dataeng::Severity;
using dataeng::TransactionSet;

bool is_space(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

bool is_delimiter(char c) {
    const unsigned char value = static_cast<unsigned char>(c);
    return value >= 0x20 && value < 0x7f && std::isgraph(value) &&
           !std::isalnum(value);
}

bool is_printable(char c) {
    const unsigned char value = static_cast<unsigned char>(c);
    return value >= 0x20 && value < 0x7f && std::isgraph(value);
}

std::string_view trim_view(std::string_view value) {
    while (!value.empty() && is_space(value.front())) {
        value.remove_prefix(1);
    }
    while (!value.empty() && is_space(value.back())) {
        value.remove_suffix(1);
    }
    return value;
}

std::string trim_copy(std::string_view value) {
    return std::string(trim_view(value));
}

std::string uppercase_copy(std::string_view value) {
    std::string result(value);
    for (char& c : result) {
        c = static_cast<char>(
            std::toupper(static_cast<unsigned char>(c)));
    }
    return result;
}

std::optional<std::size_t> parse_count(std::string_view value) {
    value = trim_view(value);
    if (value.empty()) {
        return std::nullopt;
    }
    std::size_t result = 0;
    const char* begin = value.data();
    const char* end = begin + value.size();
    const auto parsed = std::from_chars(begin, end, result);
    if (parsed.ec != std::errc{} || parsed.ptr != end) {
        return std::nullopt;
    }
    return result;
}

bool contains_error(const std::vector<Diagnostic>& diagnostics) {
    return std::any_of(diagnostics.begin(), diagnostics.end(),
                       [](const Diagnostic& diagnostic) {
                           return diagnostic.severity == Severity::error;
                       });
}

bool all_transactions_valid(const std::vector<TransactionSet>& transactions) {
    return std::all_of(transactions.begin(), transactions.end(),
                       [](const TransactionSet& transaction) {
                           return transaction.valid;
                       });
}

bool all_groups_valid(const std::vector<FunctionalGroup>& groups) {
    return std::all_of(groups.begin(), groups.end(),
                       [](const FunctionalGroup& group) { return group.valid; });
}

std::string json_escape(std::string_view value) {
    std::ostringstream output;
    for (char c : value) {
        const unsigned char byte = static_cast<unsigned char>(c);
        switch (c) {
            case '"':
                output << "\\\"";
                break;
            case '\\':
                output << "\\\\";
                break;
            case '\b':
                output << "\\b";
                break;
            case '\f':
                output << "\\f";
                break;
            case '\n':
                output << "\\n";
                break;
            case '\r':
                output << "\\r";
                break;
            case '\t':
                output << "\\t";
                break;
            default:
                if (byte < 0x20) {
                    static constexpr char hex[] = "0123456789abcdef";
                    output << "\\u00" << hex[(byte >> 4) & 0x0f]
                           << hex[byte & 0x0f];
                } else {
                    output << c;
                }
                break;
        }
    }
    return output.str();
}

void write_indent(std::ostringstream& output, int depth) {
    output << std::string(static_cast<std::size_t>(depth) * 2, ' ');
}

void write_diagnostic(std::ostringstream& output, const Diagnostic& diagnostic,
                      int depth) {
    write_indent(output, depth);
    output << "{\n";
    write_indent(output, depth + 1);
    output << "\"level\": \"" << dataeng::to_string(diagnostic.level) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"severity\": \"" << dataeng::to_string(diagnostic.severity)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"code\": \"" << json_escape(diagnostic.code) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"message\": \"" << json_escape(diagnostic.message) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"segment_id\": \"" << json_escape(diagnostic.segment_id)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"segment\": \"" << json_escape(diagnostic.segment) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"location\": {\"byte_offset\": "
           << diagnostic.location.byte_offset
           << ", \"segment_index\": " << diagnostic.location.segment_index
           << ", \"line\": " << diagnostic.location.line
           << ", \"column\": " << diagnostic.location.column << "},\n";
    write_indent(output, depth + 1);
    output << "\"expected\": \"" << json_escape(diagnostic.expected)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"actual\": \"" << json_escape(diagnostic.actual) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"sender\": \"" << json_escape(diagnostic.sender) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"receiver\": \"" << json_escape(diagnostic.receiver)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"interchange_control\": \""
           << json_escape(diagnostic.interchange_control) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"group_control\": \"" << json_escape(diagnostic.group_control)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"transaction_control\": \""
           << json_escape(diagnostic.transaction_control) << "\"\n";
    write_indent(output, depth);
    output << "}";
}

void write_diagnostics(std::ostringstream& output,
                       const std::vector<Diagnostic>& diagnostics, int depth,
                       bool trailing_comma) {
    write_indent(output, depth);
    output << "\"diagnostics\": [";
    if (!diagnostics.empty()) {
        output << "\n";
        for (std::size_t index = 0; index < diagnostics.size(); ++index) {
            write_diagnostic(output, diagnostics[index], depth + 1);
            output << (index + 1 == diagnostics.size() ? "\n" : ",\n");
        }
        write_indent(output, depth);
    }
    output << "]" << (trailing_comma ? "," : "") << "\n";
}

void write_transaction(std::ostringstream& output,
                       const TransactionSet& transaction, int depth) {
    write_indent(output, depth);
    output << "{\n";
    write_indent(output, depth + 1);
    output << "\"set_type_code\": \"" << json_escape(transaction.set_type_code)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"control_number\": \""
           << json_escape(transaction.control_number) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"declared_segment_count\": "
           << transaction.declared_segment_count << ",\n";
    write_indent(output, depth + 1);
    output << "\"actual_segment_count\": "
           << transaction.actual_segment_count << ",\n";
    write_indent(output, depth + 1);
    output << "\"complete\": " << (transaction.complete ? "true" : "false")
           << ",\n";
    write_indent(output, depth + 1);
    output << "\"envelope_valid\": "
           << (transaction.envelope_valid ? "true" : "false") << ",\n";
    write_indent(output, depth + 1);
    output << "\"valid\": " << (transaction.valid ? "true" : "false")
           << ",\n";
    write_indent(output, depth + 1);
    output << "\"start\": {\"byte_offset\": "
           << transaction.start.byte_offset
           << ", \"segment_index\": " << transaction.start.segment_index
           << ", \"line\": " << transaction.start.line
           << ", \"column\": " << transaction.start.column << "},\n";
    write_indent(output, depth + 1);
    output << "\"end\": {\"byte_offset\": " << transaction.end.byte_offset
           << ", \"segment_index\": " << transaction.end.segment_index
           << ", \"line\": " << transaction.end.line
           << ", \"column\": " << transaction.end.column << "},\n";
    write_diagnostics(output, transaction.diagnostics, depth + 1, false);
    write_indent(output, depth);
    output << "}";
}

void write_group(std::ostringstream& output, const FunctionalGroup& group,
                 int depth) {
    write_indent(output, depth);
    output << "{\n";
    write_indent(output, depth + 1);
    output << "\"functional_code\": \"" << json_escape(group.functional_code)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"application_sender\": \""
           << json_escape(group.application_sender) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"application_receiver\": \""
           << json_escape(group.application_receiver) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"control_number\": \"" << json_escape(group.control_number)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"declared_transaction_count\": "
           << group.declared_transaction_count << ",\n";
    write_indent(output, depth + 1);
    output << "\"actual_transaction_count\": "
           << group.actual_transaction_count << ",\n";
    write_indent(output, depth + 1);
    output << "\"complete\": " << (group.complete ? "true" : "false")
           << ",\n";
    write_indent(output, depth + 1);
    output << "\"envelope_valid\": "
           << (group.envelope_valid ? "true" : "false") << ",\n";
    write_indent(output, depth + 1);
    output << "\"valid\": " << (group.valid ? "true" : "false") << ",\n";
    write_indent(output, depth + 1);
    output << "\"start\": {\"byte_offset\": " << group.start.byte_offset
           << ", \"segment_index\": " << group.start.segment_index
           << ", \"line\": " << group.start.line
           << ", \"column\": " << group.start.column << "},\n";
    write_indent(output, depth + 1);
    output << "\"end\": {\"byte_offset\": " << group.end.byte_offset
           << ", \"segment_index\": " << group.end.segment_index
           << ", \"line\": " << group.end.line
           << ", \"column\": " << group.end.column << "},\n";
    write_indent(output, depth + 1);
    output << "\"transactions\": [";
    if (!group.transactions.empty()) {
        output << "\n";
        for (std::size_t index = 0; index < group.transactions.size();
             ++index) {
            write_transaction(output, group.transactions[index], depth + 2);
            output << (index + 1 == group.transactions.size() ? "\n" : ",\n");
        }
        write_indent(output, depth + 1);
    }
    output << "],\n";
    write_diagnostics(output, group.diagnostics, depth + 1, false);
    write_indent(output, depth);
    output << "}";
}

void write_interchange(std::ostringstream& output,
                       const Interchange& interchange, int depth) {
    write_indent(output, depth);
    output << "{\n";
    write_indent(output, depth + 1);
    output << "\"sender_qualifier\": \""
           << json_escape(interchange.sender_qualifier) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"sender_id\": \"" << json_escape(interchange.sender_id)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"receiver_qualifier\": \""
           << json_escape(interchange.receiver_qualifier) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"receiver_id\": \"" << json_escape(interchange.receiver_id)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"control_number\": \""
           << json_escape(interchange.control_number) << "\",\n";
    write_indent(output, depth + 1);
    output << "\"version\": \"" << json_escape(interchange.version)
           << "\",\n";
    write_indent(output, depth + 1);
    output << "\"declared_group_count\": "
           << interchange.declared_group_count << ",\n";
    write_indent(output, depth + 1);
    output << "\"actual_group_count\": " << interchange.actual_group_count
           << ",\n";
    write_indent(output, depth + 1);
    output << "\"duplicate\": " << (interchange.duplicate ? "true" : "false")
           << ",\n";
    write_indent(output, depth + 1);
    output << "\"accepted\": " << (interchange.accepted ? "true" : "false")
           << ",\n";
    write_indent(output, depth + 1);
    output << "\"complete\": " << (interchange.complete ? "true" : "false")
           << ",\n";
    write_indent(output, depth + 1);
    output << "\"envelope_valid\": "
           << (interchange.envelope_valid ? "true" : "false") << ",\n";
    write_indent(output, depth + 1);
    output << "\"valid\": " << (interchange.valid ? "true" : "false")
           << ",\n";
    write_indent(output, depth + 1);
    output << "\"start\": {\"byte_offset\": " << interchange.start.byte_offset
           << ", \"segment_index\": " << interchange.start.segment_index
           << ", \"line\": " << interchange.start.line
           << ", \"column\": " << interchange.start.column << "},\n";
    write_indent(output, depth + 1);
    output << "\"end\": {\"byte_offset\": " << interchange.end.byte_offset
           << ", \"segment_index\": " << interchange.end.segment_index
           << ", \"line\": " << interchange.end.line
           << ", \"column\": " << interchange.end.column << "},\n";
    write_indent(output, depth + 1);
    output << "\"groups\": [";
    if (!interchange.groups.empty()) {
        output << "\n";
        for (std::size_t index = 0; index < interchange.groups.size();
             ++index) {
            write_group(output, interchange.groups[index], depth + 2);
            output << (index + 1 == interchange.groups.size() ? "\n" : ",\n");
        }
        write_indent(output, depth + 1);
    }
    output << "],\n";
    write_diagnostics(output, interchange.diagnostics, depth + 1, false);
    write_indent(output, depth);
    output << "}";
}

void write_interchanges(std::ostringstream& output, const char* name,
                        const std::vector<Interchange>& interchanges, int depth,
                        bool trailing_comma) {
    write_indent(output, depth);
    output << "\"" << name << "\": [";
    if (!interchanges.empty()) {
        output << "\n";
        for (std::size_t index = 0; index < interchanges.size(); ++index) {
            write_interchange(output, interchanges[index], depth + 1);
            output << (index + 1 == interchanges.size() ? "\n" : ",\n");
        }
        write_indent(output, depth);
    }
    output << "]" << (trailing_comma ? "," : "") << "\n";
}

}  // namespace

namespace dataeng {

bool TransactionSet::has_errors() const { return contains_error(diagnostics); }

bool FunctionalGroup::has_errors() const {
    return contains_error(diagnostics) ||
           std::any_of(transactions.begin(), transactions.end(),
                       [](const TransactionSet& transaction) {
                           return transaction.has_errors();
                       });
}

bool Interchange::has_errors() const {
    return contains_error(diagnostics) ||
           std::any_of(groups.begin(), groups.end(),
                       [](const FunctionalGroup& group) {
                           return group.has_errors();
                       });
}

bool ParseResult::has_errors() const { return contains_error(diagnostics); }

bool ParseResult::ok() const { return !has_errors(); }

std::size_t ParseResult::error_count() const {
    return static_cast<std::size_t>(std::count_if(
        diagnostics.begin(), diagnostics.end(),
        [](const Diagnostic& diagnostic) {
            return diagnostic.severity == Severity::error;
        }));
}

std::size_t ParseResult::warning_count() const {
    return static_cast<std::size_t>(std::count_if(
        diagnostics.begin(), diagnostics.end(),
        [](const Diagnostic& diagnostic) {
            return diagnostic.severity == Severity::warning;
        }));
}

std::vector<Diagnostic> ParseResult::errors() const {
    std::vector<Diagnostic> filtered;
    for (const auto& diagnostic : diagnostics) {
        if (diagnostic.severity == Severity::error) {
            filtered.push_back(diagnostic);
        }
    }
    return filtered;
}

std::vector<Diagnostic> ParseResult::warnings() const {
    std::vector<Diagnostic> filtered;
    for (const auto& diagnostic : diagnostics) {
        if (diagnostic.severity == Severity::warning) {
            filtered.push_back(diagnostic);
        }
    }
    return filtered;
}

std::string ParseResult::to_json() const { return dataeng::to_json(*this); }

EnvelopeStateMachine::EnvelopeStateMachine() : options_() {}

EnvelopeStateMachine::EnvelopeStateMachine(Options options)
    : options_(options) {}

bool EnvelopeStateMachine::feed(std::string_view bytes) {
    finished_ = false;
    constexpr std::size_t compaction_threshold = 64 * 1024;
    if (cursor_ != 0 &&
        (cursor_ >= compaction_threshold || cursor_ * 2 >= pending_.size())) {
        pending_.erase(0, cursor_);
        cursor_ = 0;
    }
    pending_.append(bytes);
    pump();
    return true;
}

const ParseResult& EnvelopeStateMachine::finish() {
    if (finished_) {
        return result_;
    }
    finished_ = true;
    skip_leading_whitespace();
    const std::string_view pending = pending_view();
    if (!pending.empty()) {
        SourceLocation location = here();
        const bool partial_isa =
            pending.size() >= 3 && pending.compare(0, 3, "ISA") == 0;
        Diagnostic diagnostic;
        diagnostic.level = Level::stream;
        diagnostic.severity = Severity::error;
        diagnostic.code =
            partial_isa ? "INCOMPLETE_ISA" : "SEGMENT_UNTERMINATED_AT_EOF";
        diagnostic.message =
            partial_isa ? "the stream ends in the middle of an ISA segment"
                        : "the stream ends with an unterminated segment";
        diagnostic.segment_id = partial_isa ? "ISA" : "";
        diagnostic.segment = std::string(
            pending.substr(0, std::min<std::size_t>(pending.size(), 80)));
        diagnostic.location = location;
        emit(diagnostic, false);
        consume_prefix(pending.size());
    }
    if (transaction_open_) {
        close_transaction(false, "<end-of-stream>");
    }
    if (group_open_) {
        close_group(false, "<end-of-stream>");
    }
    if (interchange_open_) {
        close_interchange(false, "<end-of-stream>", here());
    }
    pending_.clear();
    cursor_ = 0;
    return result_;
}

const ParseResult& EnvelopeStateMachine::parse(std::string_view bytes) {
    reset();
    feed(bytes);
    return finish();
}

ParseResult EnvelopeStateMachine::run(std::string_view bytes) {
    parse(bytes);
    return result_;
}

ParseResult EnvelopeStateMachine::take_result() {
    ParseResult result = std::move(result_);
    result_ = ParseResult{};
    return result;
}

void EnvelopeStateMachine::reset() {
    result_ = ParseResult{};
    delimiters_ = Delimiters{};
    delimiters_known_ = false;
    finished_ = false;
    pending_.clear();
    cursor_ = 0;
    consumed_ = 0;
    segment_index_ = 0;
    line_ = 1;
    column_ = 1;
    interchange_open_ = false;
    group_open_ = false;
    transaction_open_ = false;
    current_interchange_ = Interchange{};
    current_group_ = FunctionalGroup{};
    current_transaction_ = TransactionSet{};
    seen_interchanges_.clear();
}

std::optional<Delimiters> EnvelopeStateMachine::delimiters() const {
    if (delimiters_known_) {
        return delimiters_;
    }
    if (!result_.delimiters.empty()) {
        return result_.delimiters.back();
    }
    return std::nullopt;
}

bool EnvelopeStateMachine::pump() {
    bool made_progress = false;
    while (true) {
        bool progress = false;
        bool keep_going = false;
        if (!delimiters_known_) {
            keep_going = try_start_interchange(progress);
        } else {
            keep_going = process_one_segment(progress);
        }
        if (progress) {
            made_progress = true;
        }
        if (!keep_going || !progress) {
            break;
        }
    }
    return made_progress;
}

bool EnvelopeStateMachine::try_start_interchange(bool& progress) {
    skip_leading_whitespace();
    const std::string_view pending = pending_view();
    if (pending.empty()) {
        return false;
    }
    if (pending.size() < 3) {
        return false;
    }
    if (pending.compare(0, 3, "ISA") != 0) {
        Diagnostic diagnostic;
        diagnostic.level = Level::stream;
        diagnostic.severity = Severity::error;
        diagnostic.code = "STREAM_DATA_BEFORE_ISA";
        diagnostic.message =
            "data was encountered outside an interchange envelope";
        diagnostic.segment = std::string(
            pending.substr(0, std::min<std::size_t>(pending.size(), 80)));
        diagnostic.location = here();
        emit(diagnostic, false);

        const std::size_t next_isa = pending.find("ISA", 1);
        if (next_isa != std::string::npos) {
            consume_prefix(next_isa);
        } else if (pending.size() > 2) {
            consume_prefix(pending.size() - 2);
        } else {
            return false;
        }
        progress = true;
        return true;
    }
    if (pending.size() < 106) {
        return false;
    }

    std::string raw_isa(pending.substr(0, 106));
    SourceLocation location = here();
    start_interchange(raw_isa, location, false);
    progress = true;
    return true;
}

bool EnvelopeStateMachine::process_one_segment(bool& progress) {
    skip_leading_whitespace();
    const std::string_view pending = pending_view();
    if (pending.empty()) {
        return false;
    }

    if (pending.size() >= 3 && pending.compare(0, 3, "ISA") == 0) {
        if (pending.size() < 106) {
            return false;
        }
        std::string raw_isa(pending.substr(0, 106));
        SourceLocation location = here();
        start_interchange(raw_isa, location, true);
        progress = true;
        return true;
    }

    const std::size_t terminator = pending.find(delimiters_.segment);
    if (terminator == std::string::npos) {
        return false;
    }

    std::string raw(pending.substr(0, terminator));
    SourceLocation location = here();
    consume_prefix(terminator + 1);
    ++segment_index_;
    progress = true;

    if (raw.empty() ||
        std::all_of(raw.begin(), raw.end(), [](char c) { return is_space(c); })) {
        return true;
    }

    Segment segment =
        parse_segment(std::move(raw), delimiters_.element, location);
    handle_segment(segment);
    return true;
}

EnvelopeStateMachine::Segment EnvelopeStateMachine::parse_segment(
    std::string raw, char element_separator, SourceLocation location) {
    Segment segment;
    segment.raw = std::move(raw);
    segment.location = location;

    std::size_t begin = 0;
    while (true) {
        const std::size_t end = segment.raw.find(element_separator, begin);
        if (end == std::string::npos) {
            segment.fields.emplace_back(segment.raw.substr(begin));
            break;
        }
        segment.fields.emplace_back(segment.raw.substr(begin, end - begin));
        begin = end + 1;
    }
    if (!segment.fields.empty()) {
        segment.id = uppercase_copy(trim_view(segment.fields.front()));
    }
    return segment;
}

void EnvelopeStateMachine::handle_segment(const Segment& segment) {
    if (!interchange_open_) {
        Diagnostic diagnostic;
        diagnostic.level = Level::stream;
        diagnostic.severity = Severity::error;
        diagnostic.code = "SEGMENT_OUTSIDE_INTERCHANGE";
        diagnostic.message = "segment " + segment.id +
                             " was encountered without an open interchange";
        diagnostic.segment_id = segment.id;
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, false);
        return;
    }
    if (current_interchange_.duplicate) {
        handle_duplicate_segment(segment);
        return;
    }

    if (segment.id == "GS") {
        handle_gs(segment);
        return;
    }
    if (segment.id == "GE") {
        handle_ge(segment);
        return;
    }
    if (segment.id == "ST") {
        handle_st(segment);
        return;
    }
    if (segment.id == "SE") {
        handle_se(segment);
        return;
    }
    if (segment.id == "IEA") {
        handle_iea(segment);
        return;
    }
    if (segment.id.empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::stream;
        diagnostic.severity = Severity::error;
        diagnostic.code = "EMPTY_SEGMENT_ID";
        diagnostic.message = "a segment with no identifier was encountered";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, false);
        return;
    }
    if (transaction_open_) {
        ++current_transaction_.actual_segment_count;
        return;
    }
    if (segment.id == "TA1") {
        return;
    }
    if (group_open_) {
        Diagnostic diagnostic;
        diagnostic.level = Level::group;
        diagnostic.severity = Severity::error;
        diagnostic.code = "SEGMENT_OUTSIDE_TRANSACTION";
        diagnostic.message =
            "segment " + segment.id +
            " was encountered outside a transaction set";
        diagnostic.segment_id = segment.id;
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
        return;
    }

    Diagnostic diagnostic;
    diagnostic.level = Level::interchange;
    diagnostic.severity = Severity::error;
    diagnostic.code = "SEGMENT_OUTSIDE_GROUP";
    diagnostic.message = "segment " + segment.id +
                         " was encountered outside a functional group";
    diagnostic.segment_id = segment.id;
    diagnostic.segment = segment.raw;
    diagnostic.location = segment.location;
    emit(diagnostic, true);
}

void EnvelopeStateMachine::handle_gs(const Segment& segment) {
    if (transaction_open_) {
        close_transaction(false, "GS");
    }
    if (group_open_) {
        close_group(false, "GS");
    }

    current_group_ = FunctionalGroup{};
    current_group_.start = segment.location;
    current_group_.complete = false;
    if (segment.fields.size() > 1) {
        current_group_.functional_code = trim_copy(segment.fields[1]);
    }
    if (segment.fields.size() > 2) {
        current_group_.application_sender = trim_copy(segment.fields[2]);
    }
    if (segment.fields.size() > 3) {
        current_group_.application_receiver = trim_copy(segment.fields[3]);
    }
    if (segment.fields.size() > 6) {
        current_group_.control_number = trim_copy(segment.fields[6]);
    }
    group_open_ = true;
    ++current_interchange_.actual_group_count;

    if (segment.fields.size() <= 6 ||
        current_group_.control_number.empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::group;
        diagnostic.severity = Severity::error;
        diagnostic.code = "GROUP_CONTROL_MISSING";
        diagnostic.message =
            "the GS envelope must declare a group control number in GS06";
        diagnostic.segment_id = "GS";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    }
}

void EnvelopeStateMachine::handle_ge(const Segment& segment) {
    if (!group_open_) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "GE_WITHOUT_GS";
        diagnostic.message =
            "a GE segment was encountered without an open functional group";
        diagnostic.segment_id = "GE";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
        return;
    }
    if (transaction_open_) {
        close_transaction(false, "GE");
    }

    current_group_.end = segment.location;
    if (segment.fields.size() <= 1) {
        Diagnostic diagnostic;
        diagnostic.level = Level::group;
        diagnostic.severity = Severity::error;
        diagnostic.code = "GROUP_TRANSACTION_COUNT_MISSING";
        diagnostic.message =
            "the GE envelope does not declare a transaction count in GE01";
        diagnostic.segment_id = "GE";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    } else {
        const auto count = parse_count(segment.fields[1]);
        if (!count.has_value()) {
            Diagnostic diagnostic;
            diagnostic.level = Level::group;
            diagnostic.severity = Severity::error;
            diagnostic.code = "GROUP_TRANSACTION_COUNT_INVALID";
            diagnostic.message =
                "GE01 is not a valid non-negative integer";
            diagnostic.segment_id = "GE";
            diagnostic.segment = segment.raw;
            diagnostic.location = segment.location;
            diagnostic.actual = trim_copy(segment.fields[1]);
            emit(diagnostic, true);
        } else {
            current_group_.declared_transaction_count = *count;
            if (options_.validate_counts &&
                current_group_.declared_transaction_count !=
                    current_group_.actual_transaction_count) {
                Diagnostic diagnostic;
                diagnostic.level = Level::group;
                diagnostic.severity = Severity::error;
                diagnostic.code = "GROUP_TRANSACTION_COUNT_MISMATCH";
                diagnostic.message =
                    "GE01 does not match the transaction sets observed in "
                    "the group";
                diagnostic.segment_id = "GE";
                diagnostic.segment = segment.raw;
                diagnostic.location = segment.location;
                diagnostic.expected =
                    std::to_string(
                        current_group_.declared_transaction_count);
                diagnostic.actual =
                    std::to_string(current_group_.actual_transaction_count);
                emit(diagnostic, true);
            }
        }
    }

    if (segment.fields.size() <= 2 ||
        trim_view(segment.fields[2]).empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::group;
        diagnostic.severity = Severity::error;
        diagnostic.code = "GROUP_CONTROL_MISSING";
        diagnostic.message =
            "the GE envelope must repeat the group control number in GE02";
        diagnostic.segment_id = "GE";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    } else if (options_.validate_controls &&
               trim_view(segment.fields[2]) !=
                   current_group_.control_number) {
        Diagnostic diagnostic;
        diagnostic.level = Level::group;
        diagnostic.severity = Severity::error;
        diagnostic.code = "GROUP_CONTROL_MISMATCH";
        diagnostic.message = "GE02 does not match GS06";
        diagnostic.segment_id = "GE";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        diagnostic.expected = current_group_.control_number;
        diagnostic.actual = trim_copy(segment.fields[2]);
        emit(diagnostic, true);
    }

    close_group(true, "GE");
}

void EnvelopeStateMachine::handle_st(const Segment& segment) {
    if (!group_open_) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "ST_WITHOUT_GS";
        diagnostic.message =
            "an ST segment was encountered without an open functional group";
        diagnostic.segment_id = "ST";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
        return;
    }
    if (transaction_open_) {
        close_transaction(false, "ST");
    }

    current_transaction_ = TransactionSet{};
    current_transaction_.start = segment.location;
    current_transaction_.actual_segment_count = 1;
    if (segment.fields.size() > 1) {
        current_transaction_.set_type_code = trim_copy(segment.fields[1]);
    }
    if (segment.fields.size() > 2) {
        current_transaction_.control_number = trim_copy(segment.fields[2]);
    }
    transaction_open_ = true;
    ++current_group_.actual_transaction_count;

    if (segment.fields.size() <= 2 ||
        current_transaction_.control_number.empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::transaction;
        diagnostic.severity = Severity::error;
        diagnostic.code = "TRANSACTION_CONTROL_MISSING";
        diagnostic.message =
            "the ST envelope must declare a transaction control number in "
            "ST02";
        diagnostic.segment_id = "ST";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    }
}

void EnvelopeStateMachine::handle_se(const Segment& segment) {
    if (!transaction_open_) {
        Diagnostic diagnostic;
        diagnostic.level = group_open_ ? Level::group : Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "SE_WITHOUT_ST";
        diagnostic.message =
            "an SE segment was encountered without an open transaction set";
        diagnostic.segment_id = "SE";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
        return;
    }

    ++current_transaction_.actual_segment_count;
    current_transaction_.end = segment.location;

    if (segment.fields.size() <= 1) {
        Diagnostic diagnostic;
        diagnostic.level = Level::transaction;
        diagnostic.severity = Severity::error;
        diagnostic.code = "TRANSACTION_SEGMENT_COUNT_MISSING";
        diagnostic.message =
            "the SE envelope does not declare a segment count in SE01";
        diagnostic.segment_id = "SE";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    } else {
        const auto count = parse_count(segment.fields[1]);
        if (!count.has_value()) {
            Diagnostic diagnostic;
            diagnostic.level = Level::transaction;
            diagnostic.severity = Severity::error;
            diagnostic.code = "TRANSACTION_SEGMENT_COUNT_INVALID";
            diagnostic.message = "SE01 is not a valid non-negative integer";
            diagnostic.segment_id = "SE";
            diagnostic.segment = segment.raw;
            diagnostic.location = segment.location;
            diagnostic.actual = trim_copy(segment.fields[1]);
            emit(diagnostic, true);
        } else {
            current_transaction_.declared_segment_count = *count;
            if (options_.validate_counts &&
                current_transaction_.declared_segment_count !=
                    current_transaction_.actual_segment_count) {
                Diagnostic diagnostic;
                diagnostic.level = Level::transaction;
                diagnostic.severity = Severity::error;
                diagnostic.code = "TRANSACTION_SEGMENT_COUNT_MISMATCH";
                diagnostic.message =
                    "SE01 does not match the ST-through-SE segment count";
                diagnostic.segment_id = "SE";
                diagnostic.segment = segment.raw;
                diagnostic.location = segment.location;
                diagnostic.expected =
                    std::to_string(
                        current_transaction_.declared_segment_count);
                diagnostic.actual =
                    std::to_string(current_transaction_.actual_segment_count);
                emit(diagnostic, true);
            }
        }
    }

    if (segment.fields.size() <= 2 ||
        trim_view(segment.fields[2]).empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::transaction;
        diagnostic.severity = Severity::error;
        diagnostic.code = "TRANSACTION_CONTROL_MISSING";
        diagnostic.message =
            "the SE envelope must repeat the transaction control number in "
            "SE02";
        diagnostic.segment_id = "SE";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    } else if (options_.validate_controls &&
               trim_view(segment.fields[2]) !=
                   current_transaction_.control_number) {
        Diagnostic diagnostic;
        diagnostic.level = Level::transaction;
        diagnostic.severity = Severity::error;
        diagnostic.code = "TRANSACTION_CONTROL_MISMATCH";
        diagnostic.message = "SE02 does not match ST02";
        diagnostic.segment_id = "SE";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        diagnostic.expected = current_transaction_.control_number;
        diagnostic.actual = trim_copy(segment.fields[2]);
        emit(diagnostic, true);
    }

    current_transaction_.complete = true;
    close_transaction(true, "SE");
}

void EnvelopeStateMachine::handle_iea(const Segment& segment) {
    if (!interchange_open_) {
        Diagnostic diagnostic;
        diagnostic.level = Level::stream;
        diagnostic.severity = Severity::error;
        diagnostic.code = "IEA_WITHOUT_ISA";
        diagnostic.message =
            "an IEA segment was encountered without an open interchange";
        diagnostic.segment_id = "IEA";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, false);
        return;
    }

    if (transaction_open_) {
        close_transaction(false, "IEA");
    }
    if (group_open_) {
        close_group(false, "IEA");
    }

    current_interchange_.end = segment.location;

    if (segment.fields.size() <= 1) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "INTERCHANGE_GROUP_COUNT_MISSING";
        diagnostic.message =
            "the IEA envelope does not declare a group count in IEA01";
        diagnostic.segment_id = "IEA";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    } else {
        const auto count = parse_count(segment.fields[1]);
        if (!count.has_value()) {
            Diagnostic diagnostic;
            diagnostic.level = Level::interchange;
            diagnostic.severity = Severity::error;
            diagnostic.code = "INTERCHANGE_GROUP_COUNT_INVALID";
            diagnostic.message = "IEA01 is not a valid non-negative integer";
            diagnostic.segment_id = "IEA";
            diagnostic.segment = segment.raw;
            diagnostic.location = segment.location;
            diagnostic.actual = trim_copy(segment.fields[1]);
            emit(diagnostic, true);
        } else {
            current_interchange_.declared_group_count = *count;
            if (options_.validate_counts &&
                current_interchange_.declared_group_count !=
                    current_interchange_.actual_group_count) {
                Diagnostic diagnostic;
                diagnostic.level = Level::interchange;
                diagnostic.severity = Severity::error;
                diagnostic.code = "INTERCHANGE_GROUP_COUNT_MISMATCH";
                diagnostic.message =
                    "IEA01 does not match the functional groups observed in "
                    "the interchange";
                diagnostic.segment_id = "IEA";
                diagnostic.segment = segment.raw;
                diagnostic.location = segment.location;
                diagnostic.expected =
                    std::to_string(
                        current_interchange_.declared_group_count);
                diagnostic.actual = std::to_string(
                    current_interchange_.actual_group_count);
                emit(diagnostic, true);
            }
        }
    }

    if (segment.fields.size() <= 2 ||
        trim_view(segment.fields[2]).empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "INTERCHANGE_CONTROL_MISSING";
        diagnostic.message =
            "the IEA envelope must repeat the interchange control number in "
            "IEA02";
        diagnostic.segment_id = "IEA";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    } else if (options_.validate_controls &&
               trim_view(segment.fields[2]) !=
                   current_interchange_.control_number) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "INTERCHANGE_CONTROL_MISMATCH";
        diagnostic.message = "IEA02 does not match ISA13";
        diagnostic.segment_id = "IEA";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        diagnostic.expected = current_interchange_.control_number;
        diagnostic.actual = trim_copy(segment.fields[2]);
        emit(diagnostic, true);
    }

    current_interchange_.complete = true;
    close_interchange(true, "IEA", segment.location);
}

void EnvelopeStateMachine::handle_duplicate_segment(
    const Segment& segment) {
    if (segment.id == "GS") {
        ++current_interchange_.actual_group_count;
        return;
    }
    if (segment.id != "IEA") {
        return;
    }

    current_interchange_.end = segment.location;
    if (segment.fields.size() <= 1) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "INTERCHANGE_GROUP_COUNT_MISSING";
        diagnostic.message =
            "the IEA envelope does not declare a group count in IEA01";
        diagnostic.segment_id = "IEA";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    } else {
        const auto count = parse_count(segment.fields[1]);
        if (count.has_value()) {
            current_interchange_.declared_group_count = *count;
            if (options_.validate_counts &&
                *count != current_interchange_.actual_group_count) {
                Diagnostic diagnostic;
                diagnostic.level = Level::interchange;
                diagnostic.severity = Severity::error;
                diagnostic.code = "INTERCHANGE_GROUP_COUNT_MISMATCH";
                diagnostic.message =
                    "IEA01 does not match the functional groups observed in "
                    "the duplicate interchange";
                diagnostic.segment_id = "IEA";
                diagnostic.segment = segment.raw;
                diagnostic.location = segment.location;
                diagnostic.expected =
                    std::to_string(*count);
                diagnostic.actual = std::to_string(
                    current_interchange_.actual_group_count);
                emit(diagnostic, true);
            }
        } else {
            Diagnostic diagnostic;
            diagnostic.level = Level::interchange;
            diagnostic.severity = Severity::error;
            diagnostic.code = "INTERCHANGE_GROUP_COUNT_INVALID";
            diagnostic.message = "IEA01 is not a valid non-negative integer";
            diagnostic.segment_id = "IEA";
            diagnostic.segment = segment.raw;
            diagnostic.location = segment.location;
            diagnostic.actual = trim_copy(segment.fields[1]);
            emit(diagnostic, true);
        }
    }
    if (segment.fields.size() <= 2 ||
        trim_view(segment.fields[2]).empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "INTERCHANGE_CONTROL_MISSING";
        diagnostic.message =
            "the IEA envelope must repeat the interchange control number in "
            "IEA02";
        diagnostic.segment_id = "IEA";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        emit(diagnostic, true);
    } else if (options_.validate_controls &&
               trim_view(segment.fields[2]) !=
                   current_interchange_.control_number) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "INTERCHANGE_CONTROL_MISMATCH";
        diagnostic.message = "IEA02 does not match ISA13";
        diagnostic.segment_id = "IEA";
        diagnostic.segment = segment.raw;
        diagnostic.location = segment.location;
        diagnostic.expected = current_interchange_.control_number;
        diagnostic.actual = trim_copy(segment.fields[2]);
        emit(diagnostic, true);
    }
    current_interchange_.complete = true;
    close_interchange(true, "IEA", segment.location);
}

void EnvelopeStateMachine::validate_isa_layout(
    const std::string& raw_isa, SourceLocation location) {
    if (!options_.validate_isa_layout) {
        return;
    }
    static constexpr std::size_t separator_positions[] = {
        3,  6,  17, 20, 31, 34, 50, 53,
        69, 76, 81, 83, 89, 99, 101, 103,
    };
    const char element = raw_isa[3];
    for (std::size_t position : separator_positions) {
        if (raw_isa[position] != element) {
            Diagnostic diagnostic;
            diagnostic.level = Level::interchange;
            diagnostic.severity = Severity::error;
            diagnostic.code = "ISA_LAYOUT_INVALID";
            diagnostic.message =
                "the ISA segment does not use fixed-width element positions";
            diagnostic.segment_id = "ISA";
            diagnostic.segment = raw_isa;
            diagnostic.location = location;
            diagnostic.expected = "element separator at byte " +
                                  std::to_string(position);
            diagnostic.actual = std::string(1, raw_isa[position]);
            emit(diagnostic, true);
            return;
        }
    }
}

bool EnvelopeStateMachine::start_interchange(
    const std::string& raw_isa, SourceLocation location,
    bool from_open_envelope) {
    if (from_open_envelope) {
        if (transaction_open_) {
            close_transaction(false, "ISA");
        }
        if (group_open_) {
            close_group(false, "ISA");
        }
        close_interchange(false, "ISA", location);
    }

    current_interchange_ = Interchange{};
    current_interchange_.start = location;

    if (raw_isa.size() != 106 ||
        raw_isa.compare(0, 3, "ISA") != 0) {
        Diagnostic diagnostic;
        diagnostic.level = Level::stream;
        diagnostic.severity = Severity::error;
        diagnostic.code = "ISA_MALFORMED";
        diagnostic.message =
            "the ISA segment must occupy exactly 106 bytes";
        diagnostic.segment_id = "ISA";
        diagnostic.segment = raw_isa;
        diagnostic.location = location;
        emit(diagnostic, false);
        consume_prefix(106);
        ++segment_index_;
        return false;
    }

    const char element = raw_isa[3];
    const char repetition = raw_isa[82];
    const char component = raw_isa[104];
    const char terminator = raw_isa[105];
    if (!is_delimiter(element) || !is_printable(repetition) ||
        !is_delimiter(component) || !is_delimiter(terminator) ||
        element == repetition || element == component ||
        element == terminator || repetition == component ||
        repetition == terminator || component == terminator) {
        Diagnostic diagnostic;
        diagnostic.level = Level::stream;
        diagnostic.severity = Severity::error;
        diagnostic.code = "ISA_DELIMITER_INVALID";
        diagnostic.message =
            "the ISA segment does not declare four distinct printable "
            "delimiters";
        diagnostic.segment_id = "ISA";
        diagnostic.segment = raw_isa;
        diagnostic.location = location;
        emit(diagnostic, false);
        consume_prefix(106);
        ++segment_index_;
        return false;
    }

    delimiters_ = Delimiters{element, repetition, component, terminator};
    delimiters_known_ = true;
    current_interchange_.sender_qualifier =
        trim_copy(raw_isa.substr(32, 2));
    current_interchange_.sender_id = trim_copy(raw_isa.substr(35, 15));
    current_interchange_.receiver_qualifier =
        trim_copy(raw_isa.substr(51, 2));
    current_interchange_.receiver_id = trim_copy(raw_isa.substr(54, 15));
    current_interchange_.version = trim_copy(raw_isa.substr(84, 5));
    current_interchange_.control_number =
        trim_copy(raw_isa.substr(90, 9));
    interchange_open_ = true;
    current_interchange_.accepted = true;
    group_open_ = false;
    transaction_open_ = false;

    validate_isa_layout(raw_isa, location);
    validate_isa_fields(raw_isa, location);

    if (options_.deduplicate_interchanges) {
        const std::string key = current_interchange_.sender_id + '\x1f' +
                                current_interchange_.control_number;
        const bool inserted = seen_interchanges_.insert(key).second;
        if (!inserted) {
            current_interchange_.duplicate = true;
            current_interchange_.accepted = false;
            Diagnostic diagnostic;
            diagnostic.level = Level::interchange;
            diagnostic.severity = Severity::info;
            diagnostic.code = "DUPLICATE_INTERCHANGE";
            diagnostic.message =
                "the interchange was ignored because sender and control "
                "number were already observed";
            diagnostic.segment_id = "ISA";
            diagnostic.segment = raw_isa;
            diagnostic.location = location;
            diagnostic.expected = "unique sender + ISA13";
            diagnostic.actual = current_interchange_.sender_id + " / " +
                                current_interchange_.control_number;
            emit(diagnostic, true);
        }
    }

    result_.delimiters.push_back(delimiters_);
    consume_prefix(106);
    ++segment_index_;
    return true;
}

void EnvelopeStateMachine::validate_isa_fields(const std::string& raw_isa,
                                               SourceLocation location) {
    if (current_interchange_.sender_id.empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "ISA_SENDER_MISSING";
        diagnostic.message = "ISA06 does not contain a sender identifier";
        diagnostic.segment_id = "ISA";
        diagnostic.segment = raw_isa;
        diagnostic.location = location;
        emit(diagnostic, true);
    }
    if (current_interchange_.receiver_id.empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "ISA_RECEIVER_MISSING";
        diagnostic.message = "ISA08 does not contain a receiver identifier";
        diagnostic.segment_id = "ISA";
        diagnostic.segment = raw_isa;
        diagnostic.location = location;
        emit(diagnostic, true);
    }
    if (current_interchange_.control_number.empty()) {
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "ISA_CONTROL_MISSING";
        diagnostic.message =
            "ISA13 does not contain an interchange control number";
        diagnostic.segment_id = "ISA";
        diagnostic.segment = raw_isa;
        diagnostic.location = location;
        emit(diagnostic, true);
    }
}

void EnvelopeStateMachine::close_transaction(bool saw_se,
                                             std::string_view trigger) {
    if (!transaction_open_) {
        return;
    }
    current_transaction_.complete = saw_se;
    if (!saw_se) {
        Diagnostic diagnostic;
        diagnostic.level = Level::transaction;
        diagnostic.severity = Severity::error;
        diagnostic.code = "TRANSACTION_UNCLOSED";
        diagnostic.message =
            "the transaction set was not closed with an SE segment";
        diagnostic.segment_id = std::string(trigger);
        diagnostic.location = current_transaction_.start;
        diagnostic.expected = "SE";
        diagnostic.actual = std::string(trigger);
        emit(diagnostic, true);
    }
    current_transaction_.envelope_valid =
        current_transaction_.complete &&
        !contains_error(current_transaction_.diagnostics);
    current_transaction_.valid = current_transaction_.envelope_valid;
    if (group_open_) {
        current_group_.transactions.push_back(
            std::move(current_transaction_));
    }
    current_transaction_ = TransactionSet{};
    transaction_open_ = false;
}

void EnvelopeStateMachine::close_group(bool saw_ge,
                                       std::string_view trigger) {
    if (!group_open_) {
        return;
    }
    current_group_.complete = saw_ge;
    if (!saw_ge) {
        Diagnostic diagnostic;
        diagnostic.level = Level::group;
        diagnostic.severity = Severity::error;
        diagnostic.code = "GROUP_UNCLOSED";
        diagnostic.message =
            "the functional group was not closed with a GE segment";
        diagnostic.segment_id = std::string(trigger);
        diagnostic.location = current_group_.start;
        diagnostic.expected = "GE";
        diagnostic.actual = std::string(trigger);
        emit(diagnostic, true);
    }
    current_group_.envelope_valid =
        current_group_.complete &&
        !contains_error(current_group_.diagnostics);
    current_group_.valid =
        current_group_.envelope_valid &&
        all_transactions_valid(current_group_.transactions);
    if (interchange_open_) {
        current_interchange_.groups.push_back(std::move(current_group_));
    }
    current_group_ = FunctionalGroup{};
    group_open_ = false;
}

void EnvelopeStateMachine::close_interchange(bool saw_iea,
                                             std::string_view trigger,
                                             SourceLocation location) {
    if (!interchange_open_) {
        return;
    }
    current_interchange_.complete = saw_iea;
    if (!saw_iea) {
        current_interchange_.end = location;
        Diagnostic diagnostic;
        diagnostic.level = Level::interchange;
        diagnostic.severity = Severity::error;
        diagnostic.code = "INTERCHANGE_UNCLOSED";
        diagnostic.message =
            "the interchange was not closed with an IEA segment";
        diagnostic.segment_id = std::string(trigger);
        diagnostic.location = current_interchange_.start;
        diagnostic.expected = "IEA";
        diagnostic.actual = std::string(trigger);
        emit(diagnostic, true);
    }
    current_interchange_.envelope_valid =
        current_interchange_.complete &&
        !contains_error(current_interchange_.diagnostics);
    current_interchange_.valid =
        current_interchange_.envelope_valid &&
        all_groups_valid(current_interchange_.groups);
    current_interchange_.accepted = !current_interchange_.duplicate;
    if (current_interchange_.duplicate) {
        result_.duplicates.push_back(std::move(current_interchange_));
    } else {
        result_.interchanges.push_back(std::move(current_interchange_));
    }
    current_interchange_ = Interchange{};
    interchange_open_ = false;
    group_open_ = false;
    transaction_open_ = false;
    delimiters_known_ = false;
}

void EnvelopeStateMachine::emit(Diagnostic diagnostic,
                                bool attach_to_current) {
    attach_context(diagnostic);
    result_.diagnostics.push_back(diagnostic);
    if (!attach_to_current) {
        return;
    }
    const Diagnostic copy = diagnostic;
    switch (diagnostic.level) {
        case Level::transaction:
            if (transaction_open_) {
                current_transaction_.diagnostics.push_back(copy);
            } else if (group_open_) {
                current_group_.diagnostics.push_back(copy);
            } else if (interchange_open_) {
                current_interchange_.diagnostics.push_back(copy);
            }
            break;
        case Level::group:
            if (group_open_) {
                current_group_.diagnostics.push_back(copy);
            } else if (interchange_open_) {
                current_interchange_.diagnostics.push_back(copy);
            }
            break;
        case Level::interchange:
            if (interchange_open_) {
                current_interchange_.diagnostics.push_back(copy);
            }
            break;
        case Level::stream:
            break;
    }
}

void EnvelopeStateMachine::attach_context(
    Diagnostic& diagnostic) const {
    if (interchange_open_) {
        if (!current_interchange_.sender_id.empty()) {
            diagnostic.sender =
                current_interchange_.sender_qualifier.empty()
                    ? current_interchange_.sender_id
                    : current_interchange_.sender_qualifier + ":" +
                          current_interchange_.sender_id;
        }
        if (!current_interchange_.receiver_id.empty()) {
            diagnostic.receiver =
                current_interchange_.receiver_qualifier.empty()
                    ? current_interchange_.receiver_id
                    : current_interchange_.receiver_qualifier + ":" +
                          current_interchange_.receiver_id;
        }
        diagnostic.interchange_control =
            current_interchange_.control_number;
    }
    if (group_open_) {
        diagnostic.group_control = current_group_.control_number;
    }
    if (transaction_open_) {
        diagnostic.transaction_control =
            current_transaction_.control_number;
    }
}

SourceLocation EnvelopeStateMachine::here() const {
    return SourceLocation{consumed_, segment_index_, line_, column_};
}

void EnvelopeStateMachine::skip_leading_whitespace() {
    if (!options_.ignore_leading_whitespace) {
        return;
    }
    const std::string_view pending = pending_view();
    std::size_t count = 0;
    while (count < pending.size() && is_space(pending[count])) {
        ++count;
    }
    if (count != 0) {
        consume_prefix(count);
    }
}

void EnvelopeStateMachine::consume_prefix(std::size_t count) {
    count = std::min(count, pending_.size() - cursor_);
    for (std::size_t index = 0; index < count; ++index) {
        const char c = pending_[cursor_ + index];
        ++consumed_;
        if (c == '\n') {
            ++line_;
            column_ = 1;
        } else if (c == '\r') {
            column_ = 1;
        } else {
            ++column_;
        }
    }
    cursor_ += count;
}

ParseResult parse(std::string_view bytes,
                  EnvelopeStateMachine::Options options) {
    EnvelopeStateMachine machine(options);
    machine.feed(bytes);
    machine.finish();
    return machine.result();
}

ParseResult parse_x12(std::string_view bytes,
                      EnvelopeStateMachine::Options options) {
    return parse(bytes, options);
}

ParseResult parse_envelope(std::string_view bytes,
                           EnvelopeStateMachine::Options options) {
    return parse(bytes, options);
}

ParseResult validate(std::string_view bytes,
                     EnvelopeStateMachine::Options options) {
    return parse(bytes, options);
}

std::optional<Delimiters> derive_delimiters(
    std::string_view isa_or_stream) {
    while (!isa_or_stream.empty() && is_space(isa_or_stream.front())) {
        isa_or_stream.remove_prefix(1);
    }
    if (isa_or_stream.size() < 106 ||
        isa_or_stream.compare(0, 3, "ISA") != 0) {
        return std::nullopt;
    }
    const char element = isa_or_stream[3];
    const char repetition = isa_or_stream[82];
    const char component = isa_or_stream[104];
    const char terminator = isa_or_stream[105];
    if (!is_delimiter(element) || !is_printable(repetition) ||
        !is_delimiter(component) || !is_delimiter(terminator) ||
        element == repetition || element == component ||
        element == terminator || repetition == component ||
        repetition == terminator || component == terminator) {
        return std::nullopt;
    }
    return Delimiters{element, repetition, component, terminator};
}

const char* to_string(Level level) {
    switch (level) {
        case Level::stream:
            return "stream";
        case Level::interchange:
            return "interchange";
        case Level::group:
            return "group";
        case Level::transaction:
            return "transaction";
    }
    return "unknown";
}

const char* to_string(Severity severity) {
    switch (severity) {
        case Severity::info:
            return "info";
        case Severity::warning:
            return "warning";
        case Severity::error:
            return "error";
    }
    return "unknown";
}

std::string to_json(const Diagnostic& diagnostic) {
    std::ostringstream output;
    write_diagnostic(output, diagnostic, 0);
    return output.str();
}

std::string to_json(const TransactionSet& transaction) {
    std::ostringstream output;
    write_transaction(output, transaction, 0);
    return output.str();
}

std::string to_json(const FunctionalGroup& group) {
    std::ostringstream output;
    write_group(output, group, 0);
    return output.str();
}

std::string to_json(const Interchange& interchange) {
    std::ostringstream output;
    write_interchange(output, interchange, 0);
    return output.str();
}

std::string to_json(const ParseResult& result) {
    std::ostringstream output;
    output << "{\n";
    write_indent(output, 1);
    output << "\"ok\": " << (result.ok() ? "true" : "false") << ",\n";
    write_indent(output, 1);
    output << "\"interchange_count\": " << result.interchanges.size()
           << ",\n";
    write_indent(output, 1);
    output << "\"duplicate_count\": " << result.duplicates.size() << ",\n";
    write_indent(output, 1);
    output << "\"error_count\": " << result.error_count() << ",\n";
    write_indent(output, 1);
    output << "\"warning_count\": " << result.warning_count() << ",\n";
    write_interchanges(output, "interchanges", result.interchanges, 1, true);
    write_interchanges(output, "duplicates", result.duplicates, 1, true);
    write_diagnostics(output, result.diagnostics, 1, true);
    write_indent(output, 1);
    output << "\"delimiters\": [";
    if (!result.delimiters.empty()) {
        output << "\n";
        for (std::size_t index = 0; index < result.delimiters.size();
             ++index) {
            const auto& delimiters = result.delimiters[index];
            write_indent(output, 2);
            output << "{\"element\": \""
                   << json_escape(std::string(1, delimiters.element))
                   << "\", \"repetition\": \""
                   << json_escape(std::string(1, delimiters.repetition))
                   << "\", \"component\": \""
                   << json_escape(std::string(1, delimiters.component))
                   << "\", \"segment\": \""
                   << json_escape(std::string(1, delimiters.segment))
                   << "\"}";
            output << (index + 1 == result.delimiters.size() ? "\n" : ",\n");
        }
        write_indent(output, 1);
    }
    output << "]\n";
    output << "}\n";
    return output.str();
}

}  // namespace dataeng
