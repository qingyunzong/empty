#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace dataeng {

enum class Level {
    stream,
    interchange,
    group,
    transaction,
};

enum class Severity {
    info,
    warning,
    error,
};

struct SourceLocation {
    std::size_t byte_offset = 0;
    std::size_t segment_index = 0;
    std::size_t line = 1;
    std::size_t column = 1;
};

struct Diagnostic {
    Level level = Level::stream;
    Severity severity = Severity::error;
    std::string code;
    std::string message;
    std::string segment_id;
    std::string segment;
    SourceLocation location;
    std::string expected;
    std::string actual;
    std::string sender;
    std::string receiver;
    std::string interchange_control;
    std::string group_control;
    std::string transaction_control;
};

using Evidence = Diagnostic;

struct Delimiters {
    char element = '*';
    char repetition = '^';
    char component = ':';
    char segment = '~';
};

struct TransactionSet {
    std::string set_type_code;
    std::string control_number;
    std::size_t declared_segment_count = 0;
    std::size_t actual_segment_count = 0;
    bool complete = false;
    bool envelope_valid = false;
    bool valid = false;
    SourceLocation start;
    SourceLocation end;
    std::vector<Diagnostic> diagnostics;

    bool has_errors() const;
};

struct FunctionalGroup {
    std::string functional_code;
    std::string application_sender;
    std::string application_receiver;
    std::string control_number;
    std::size_t declared_transaction_count = 0;
    std::size_t actual_transaction_count = 0;
    bool complete = false;
    bool envelope_valid = false;
    bool valid = false;
    SourceLocation start;
    SourceLocation end;
    std::vector<TransactionSet> transactions;
    std::vector<Diagnostic> diagnostics;

    bool has_errors() const;
};

struct Interchange {
    std::string sender_qualifier;
    std::string sender_id;
    std::string receiver_qualifier;
    std::string receiver_id;
    std::string control_number;
    std::string version;
    std::size_t declared_group_count = 0;
    std::size_t actual_group_count = 0;
    bool duplicate = false;
    bool accepted = false;
    bool complete = false;
    bool envelope_valid = false;
    bool valid = false;
    SourceLocation start;
    SourceLocation end;
    std::vector<FunctionalGroup> groups;
    std::vector<Diagnostic> diagnostics;

    bool has_errors() const;
};

struct ParseResult {
    std::vector<Interchange> interchanges;
    std::vector<Interchange> duplicates;
    std::vector<Diagnostic> diagnostics;
    std::vector<Delimiters> delimiters;

    bool ok() const;
    bool has_errors() const;
    std::size_t error_count() const;
    std::size_t warning_count() const;
    std::vector<Diagnostic> errors() const;
    std::vector<Diagnostic> warnings() const;
    const std::vector<Diagnostic>& all_diagnostics() const {
        return diagnostics;
    }
    std::string to_json() const;
};

class EnvelopeStateMachine {
public:
    struct Options {
        bool deduplicate_interchanges = true;
        bool validate_controls = true;
        bool validate_counts = true;
        bool validate_isa_layout = true;
        bool ignore_leading_whitespace = true;
    };

    EnvelopeStateMachine();
    explicit EnvelopeStateMachine(Options options);

    bool feed(std::string_view bytes);
    bool feed(const char* bytes, std::size_t size) {
        return feed(std::string_view(bytes, size));
    }
    bool feed(const std::vector<char>& bytes) {
        return feed(std::string_view(bytes.data(), bytes.size()));
    }
    bool push(std::string_view bytes) { return feed(bytes); }
    bool append(std::string_view bytes) { return feed(bytes); }
    bool consume(std::string_view bytes) { return feed(bytes); }

    const ParseResult& finish();
    const ParseResult& parse(std::string_view bytes);
    ParseResult run(std::string_view bytes);
    const ParseResult& result() const { return result_; }
    const ParseResult& report() const { return result_; }
    ParseResult take_result();

    void reset();
    bool waiting_for_isa() const { return !delimiters_known_ && !interchange_open_; }
    bool has_open_interchange() const { return interchange_open_; }
    std::optional<Delimiters> delimiters() const;
    const Options& options() const { return options_; }

    std::string to_json() const { return result_.to_json(); }

private:
    struct Segment {
        std::string id;
        std::string raw;
        std::vector<std::string> fields;
        SourceLocation location;
    };

    bool pump();
    bool try_start_interchange(bool& progress);
    bool process_one_segment(bool& progress);
    void handle_segment(const Segment& segment);
    void handle_gs(const Segment& segment);
    void handle_ge(const Segment& segment);
    void handle_st(const Segment& segment);
    void handle_se(const Segment& segment);
    void handle_iea(const Segment& segment);
    void handle_duplicate_segment(const Segment& segment);

    void validate_isa_layout(const std::string& raw_isa, SourceLocation location);
    bool start_interchange(const std::string& raw_isa, SourceLocation location,
                           bool from_open_envelope);
    void validate_isa_fields(const std::string& raw_isa,
                             SourceLocation location);

    void close_transaction(bool saw_se, std::string_view trigger);
    void close_group(bool saw_ge, std::string_view trigger);
    void close_interchange(bool saw_iea, std::string_view trigger, SourceLocation location);

    void emit(Diagnostic diagnostic, bool attach_to_current = true);
    void attach_context(Diagnostic& diagnostic) const;
    SourceLocation here() const;
    void skip_leading_whitespace();
    void consume_prefix(std::size_t count);
    std::string_view pending_view() const {
        return std::string_view(pending_).substr(cursor_);
    }

    static Segment parse_segment(std::string raw, char element_separator,
                                 SourceLocation location);

    Options options_;
    ParseResult result_;
    Delimiters delimiters_;
    bool delimiters_known_ = false;
    bool finished_ = false;

    std::string pending_;
    std::size_t cursor_ = 0;
    std::size_t consumed_ = 0;
    std::size_t segment_index_ = 0;
    std::size_t line_ = 1;
    std::size_t column_ = 1;

    bool interchange_open_ = false;
    bool group_open_ = false;
    bool transaction_open_ = false;
    Interchange current_interchange_;
    FunctionalGroup current_group_;
    TransactionSet current_transaction_;
    std::unordered_set<std::string> seen_interchanges_;
};

using X12EnvelopeStateMachine = EnvelopeStateMachine;
using X12EnvelopeParser = EnvelopeStateMachine;
using X12EnvelopeValidator = EnvelopeStateMachine;
using X12StateMachine = EnvelopeStateMachine;
using X12Parser = EnvelopeStateMachine;
using EnvelopeParser = EnvelopeStateMachine;
using EnvelopeValidator = EnvelopeStateMachine;
using InterchangeParser = EnvelopeStateMachine;
using Parser = EnvelopeStateMachine;
using EnvelopeLevel = Level;
using IssueSeverity = Severity;
using Issue = Diagnostic;
using ParseReport = ParseResult;
using ValidationReport = ParseResult;

ParseResult parse(std::string_view bytes, EnvelopeStateMachine::Options options = {});
ParseResult parse_x12(std::string_view bytes, EnvelopeStateMachine::Options options = {});
ParseResult parse_envelope(std::string_view bytes,
                           EnvelopeStateMachine::Options options = {});
ParseResult validate(std::string_view bytes,
                     EnvelopeStateMachine::Options options = {});
std::optional<Delimiters> derive_delimiters(std::string_view isa_or_stream);

std::string to_json(const ParseResult& result);
std::string to_json(const Diagnostic& diagnostic);
std::string to_json(const Interchange& interchange);
std::string to_json(const FunctionalGroup& group);
std::string to_json(const TransactionSet& transaction);
const char* to_string(Level level);
const char* to_string(Severity severity);

namespace x12 {
using dataeng::Delimiters;
using dataeng::Diagnostic;
using dataeng::EnvelopeStateMachine;
using dataeng::Evidence;
using dataeng::FunctionalGroup;
using dataeng::Interchange;
using dataeng::ParseResult;
using dataeng::TransactionSet;
using dataeng::derive_delimiters;
using dataeng::parse;
using dataeng::parse_envelope;
using dataeng::parse_x12;
using dataeng::to_json;
using dataeng::validate;
}  // namespace x12

namespace edi {
using dataeng::Delimiters;
using dataeng::Diagnostic;
using dataeng::EnvelopeStateMachine;
using dataeng::Evidence;
using dataeng::FunctionalGroup;
using dataeng::Interchange;
using dataeng::ParseResult;
using dataeng::TransactionSet;
using dataeng::derive_delimiters;
using dataeng::parse;
using dataeng::parse_envelope;
using dataeng::parse_x12;
using dataeng::to_json;
using dataeng::validate;
}  // namespace edi

}  // namespace dataeng
