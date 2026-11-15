#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace dataeng {

// EDIFACT service delimiters. Defaults follow ISO 9735 when no UNA
// service string advice is present.
struct Delimiters {
    char component = ':';
    char element = '+';
    char decimal = '.';
    char release = '?';
    char terminator = '\'';
};

struct Segment {
    std::string tag;
    // Elements, each split into composite components (unescaped).
    std::vector<std::vector<std::string>> elements;
    std::string raw;   // raw segment text, escapes preserved
    std::size_t offset = 0;
};

enum class Severity { Error, Warning };

struct Issue {
    Severity severity = Severity::Error;
    std::string code;
    std::string detail;
    std::size_t offset = 0;
};

struct Message {
    std::string reference;
    std::string type;
    std::string version;
    std::vector<Segment> segments;  // UNH .. UNT inclusive
    std::size_t declared_segment_count = 0;
    bool count_ok = false;
    // Quarantined messages are isolated from the good set but still
    // participate in group/interchange count reconciliation.
    bool isolated = false;
};

struct Group {
    std::string control_ref;
    std::string type;
    std::vector<Message> messages;
    std::size_t declared_message_count = 0;
    bool count_ok = false;
};

struct Interchange {
    std::string control_ref;
    std::string sender_id;
    std::string recipient_id;
    std::string syntax_id;
    std::string syntax_version;
    bool used_una = false;
    Delimiters delimiters;
    std::vector<Group> groups;     // UNG/UNE functional groups
    std::vector<Message> messages; // messages directly under UNB
    std::size_t declared_count = 0; // UNZ trailer count
    bool count_ok = false;
    std::string content_fingerprint; // stable hash for dedup
};

struct ParseResult {
    Interchange interchange;
    std::vector<Issue> issues;
    bool ok() const;
};

// Parse one EDIFACT interchange (optional UNA, UNB..UNZ envelope).
ParseResult parse_interchange(std::string_view data);

enum class DedupStatus {
    Accepted,     // first sighting of this control number
    Duplicate,    // same content seen before: idempotent confirm
    Conflict,     // control number reused with different content
};

struct DedupOutcome {
    DedupStatus status = DedupStatus::Accepted;
    std::string detail;
};

// Control-number dedup bound to (sender, syntax version, control ref).
class InterchangeRegistry {
public:
    DedupOutcome submit(const Interchange& interchange);
    std::size_t size() const { return seen_.size(); }

private:
    struct Key {
        std::string sender;
        std::string syntax_version;
        std::string control_ref;
        bool operator==(const Key&) const = default;
    };
    struct KeyHash {
        std::size_t operator()(const Key& key) const;
    };
    std::unordered_map<Key, std::string, KeyHash> seen_;
};

} // namespace dataeng
