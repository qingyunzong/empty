#pragma once

#include <cstdint>
#include <istream>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace seqcheck {

// One parsed packet record from the log, keeping the raw line as evidence.
struct Packet {
    std::uint64_t stream = 0;
    std::uint64_t seq = 0;    // raw sequence number as logged
    std::size_t line_no = 0;  // 1-based line number in the input
    std::string raw;          // original line text (evidence)
};

enum class ConflictKind {
    Parse,        // line could not be parsed
    Gap,          // resolved seq is ahead of expected: prefix-order violation
    Unresolvable, // no candidate seq within the disambiguation window
    Ambiguous,    // more than one candidate within the window
};

struct Conflict {
    ConflictKind kind = ConflictKind::Parse;
    std::size_t line_no = 0;
    std::uint64_t stream = 0;
    std::uint64_t seq = 0;      // raw seq from the packet (0 for parse errors)
    std::uint64_t expected = 0; // next expected absolute seq for the stream
    std::string message;
    std::string evidence; // original raw line
};

struct Stats {
    std::uint64_t packets = 0;   // total packet records processed
    std::uint64_t delivered = 0; // first-time in-order deliveries
    std::uint64_t retrans = 0;   // retransmissions (already delivered, ignored)
    std::size_t streams = 0;     // distinct streams seen
};

struct CheckResult {
    std::optional<Conflict> conflict; // first conflict, if any
    Stats stats;
};

// Validate modulus/window pair. Returns an error message or empty string.
// Disambiguation is only well-defined when 2*window <= modulus.
std::string validate_params(std::uint64_t modulus, std::uint64_t window);

// All absolute sequence numbers k with k == raw (mod modulus) inside
// [max(0, expected-window), expected+window).
std::vector<std::uint64_t> resolve_candidates(std::uint64_t raw,
                                              std::uint64_t expected,
                                              std::uint64_t modulus,
                                              std::uint64_t window);

// Deterministic greedy checker: processes packets in log order.
CheckResult check_packets(const std::vector<Packet>& packets,
                          std::uint64_t modulus, std::uint64_t window);

// Parse a log stream ("<stream> <seq>" per line, '#' comments, blank lines).
// On the first malformed line, returns a Parse conflict instead of packets.
struct ParseResult {
    std::vector<Packet> packets;
    std::optional<Conflict> conflict; // parse error, if any
};
ParseResult parse_log(std::istream& in);

// Parse and check in one go. Parse failures are reported as the conflict.
CheckResult check_log(std::istream& in, std::uint64_t modulus,
                      std::uint64_t window);

// Reference verifier: existential search over ALL legal delivery sequences
// (feasible for small modulus/window). Returns true iff some interpretation
// of the log (each packet either a retransmission or the next in-order
// delivery per stream) is consistent end to end.
bool reference_consistent(const std::vector<Packet>& packets,
                          std::uint64_t modulus, std::uint64_t window);

} // namespace seqcheck
