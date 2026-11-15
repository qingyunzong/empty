#pragma once

#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace dataeng {

// ---------------------------------------------------------------------------
// Diagnostics and repair guidance
// ---------------------------------------------------------------------------

enum class Severity { info, warning, error };

std::string_view to_string(Severity severity);

struct Diagnostic {
    Severity severity = Severity::error;
    // Stable, machine-readable identifier (for example "digest_mismatch").
    std::string code;
    std::string message;
    std::string record_id;
    std::string related_id;
    std::optional<std::size_t> record_index;
    bool repairable = false;
};

// An action that a caller can take to turn an incomplete archive into a
// complete one.  Repair actions never imply that data was invented by the
// assembler: every action names the missing or damaged input explicitly.
struct RepairAction {
    std::string code;
    std::string record_id;
    std::string missing_id;
    std::string action;
    std::string detail;
};

// ---------------------------------------------------------------------------
// WARC records
// ---------------------------------------------------------------------------

struct Field {
    std::string name;
    std::string value;
};

struct Record {
    std::size_t index = 0;   // zero-based position in the input stream
    std::size_t offset = 0;  // byte offset of the "WARC/" version line
    std::string version;     // "WARC/1.0" or "WARC/1.1"
    std::vector<Field> fields;
    std::string body;
    bool truncated = false;
    bool malformed = false;

    // Header lookup is case-insensitive.  header() returns the first value.
    std::string header(std::string_view name) const;
    std::vector<std::string> headers(std::string_view name) const;
    bool has_header(std::string_view name) const;

    std::string type() const;  // lower-cased WARC-Type
    std::string raw_id() const;
    std::string id() const;  // normalized WARC-Record-ID
    std::string date() const;
    std::string target_uri() const;
    std::string content_type() const;
    std::optional<std::uint64_t> content_length() const;
    std::optional<std::uint64_t> segment_number() const;
    std::string segment_origin_id() const;
    std::optional<std::uint64_t> segment_total_length() const;
    std::vector<std::string> concurrent_to() const;
    std::string refers_to() const;
    std::string refers_to_target_uri() const;
    std::string refers_to_date() const;
    std::string profile() const;

    // True when this physical record is a continuation (segment number > 1 or
    // WARC-Type: continuation), independently of whether its origin exists.
    bool is_segment_continuation() const;
};

// Remove optional angle brackets and normalize the case of urn:uuid values.
// Other URI forms are preserved: URI paths are case-sensitive.
std::string normalize_record_id(std::string_view id);
bool same_record_id(std::string_view a, std::string_view b);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

struct ParseOptions {
    bool tolerate_lf_line_endings = true;
    bool recover_after_errors = true;
    // If true, a final record without the required CRLFCRLF separator is an
    // error rather than a warning.
    bool strict_record_separator = false;
};

struct ParseResult {
    std::vector<Record> records;
    std::vector<Diagnostic> diagnostics;

    bool ok() const;
};

ParseResult parse_warc(std::string_view data, const ParseOptions& options = {});
ParseResult parse_warc_stream(std::istream& input, const ParseOptions& options = {});

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

// Lower-case algorithm name, one of "sha1", "sha256" or "md5".
std::string digest_hex(std::string_view algorithm, std::string_view data);
std::string digest_base32(std::string_view algorithm, std::string_view data);

// Parse a WARC digest value such as "sha1:BASE32" or "sha256:HEX".  A header
// can contain several comma-separated digest values.  Returns an empty vector
// and sets error for an unsupported algorithm or malformed value.
struct DigestValue {
    std::string algorithm;
    std::string hex;  // normalized lower-case hexadecimal bytes
};
std::vector<DigestValue> parse_digest_values(std::string_view value,
                                             std::string* error = nullptr);

// True when value (a WARC digest header value, possibly comma separated)
// contains a digest of data.  The matching digest spec is returned in matched.
bool verify_digest(std::string_view value, std::string_view data,
                   DigestValue* matched = nullptr, std::string* error = nullptr);

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

struct AssembleOptions {
    bool verify_digests = true;
    bool verify_segment_lengths = true;
    // Require a WARC-Block-Digest or WARC-Payload-Digest on each logical
    // record.  Off by default because the field is optional in WARC.
    bool require_digest = false;
    // Treat a response/revisit without a captured request as incomplete.
    bool require_request = true;
    // Allow a revisit to resolve its payload by a unique payload digest when
    // WARC-Refers-To and WARC-Refers-To-Target-URI are absent.
    bool revisits_by_digest = true;
};

struct SegmentRef {
    std::size_t record_index = 0;
    std::uint64_t number = 0;
    std::uint64_t content_length = 0;
};

// A record after continuation segments have been combined.  Exactly one
// physical record is the head unless has_head is false.
struct LogicalRecord {
    std::string id;        // head id when known, otherwise first segment id
    std::string origin_id; // segment origin id, when one was supplied
    std::string type;
    std::string target_uri;
    std::string date;
    std::size_t head_index = 0;
    bool has_head = false;
    bool segmented = false;
    bool complete = true;  // segments, lengths, digests, and revisit refs are valid
    std::vector<SegmentRef> segments;
    std::string block;    // concatenated segment bodies
    std::string payload;  // HTTP entity body, or block for payload records
    std::uint64_t total_length = 0;
    // For a revisit, the logical record holding the known payload.  The
    // payload is deliberately not copied into the revisit.
    std::optional<std::size_t> revisit_target;
    std::vector<Diagnostic> diagnostics;
};

struct MissingLink {
    // "response", "request", "payload", "segment", "segment_origin",
    // "record", or "metadata_target".
    std::string kind;
    std::string record_id;  // record that contains the dangling reference
    std::string reference;  // missing id or other reference value
    std::string reason;
    std::optional<std::size_t> record_index;
};

struct Exchange {
    // Stable identifier of the root record.  It is the response id, or the
    // revisit id when the exchange has no captured response.  If the root has
    // no usable record id, a report-local "#record-N" label is used; it is not
    // a synthesized WARC-Record-ID.
    std::string id;
    std::optional<std::size_t> response;  // logical record index
    std::optional<std::size_t> revisit;   // logical record index
    std::vector<std::size_t> requests;    // logical record indices
    std::vector<std::size_t> metadata;    // logical record indices
    std::vector<std::size_t> related;     // other associated logical records
    std::vector<MissingLink> missing;
    std::vector<RepairAction> repairs;
    bool complete = false;
};

struct Assembly {
    std::vector<Record> records;
    std::vector<LogicalRecord> logical_records;
    std::vector<Exchange> exchanges;
    std::vector<std::size_t> unpaired_requests;   // logical record indices
    std::vector<std::size_t> unpaired_metadata;   // logical record indices
    std::vector<std::size_t> unpaired_responses;  // logical record indices
    std::vector<MissingLink> missing_links;
    std::vector<RepairAction> repairs;
    std::vector<Diagnostic> parse_diagnostics;
    std::vector<Diagnostic> diagnostics;

    bool ok() const;        // no error diagnostics (parse or assembly)
    bool complete() const;  // ok, at least one exchange, all records/exchanges complete
    const Record& record(std::size_t index) const;
};

Assembly assemble(std::vector<Record> records,
                  const AssembleOptions& options = {});
Assembly assemble(ParseResult parsed, const AssembleOptions& options = {});
Assembly assemble(std::string_view warc,
                  const ParseOptions& parse_options = {},
                  const AssembleOptions& options = {});
Assembly assemble(std::istream& input,
                  const ParseOptions& parse_options = {},
                  const AssembleOptions& options = {});

// Deterministic JSON representation used by the bundled command-line tool.
std::string to_json(const ParseResult& result);
std::string to_json(const Assembly& assembly);

}  // namespace dataeng
