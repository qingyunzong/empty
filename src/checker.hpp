#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>

namespace seqcheck {

// Verification parameters. Sequence numbers live in [0, modulus) and wrap
// around; a raw sequence number is mapped to its monotonic ("extended")
// counterpart by picking the representative within `window` of the stream's
// next-expected position. A sequence number exactly `window` behind and
// `window` ahead at the same time (possible when 2 * window == modulus)
// resolves to the future, i.e. it is treated as a new (gap) delivery.
struct Params {
  std::uint64_t modulus = 16;
  std::uint64_t window = 8;
};

struct Packet {
  std::uint64_t line_no = 0;
  std::string raw;  // original log line, kept as evidence
  std::uint64_t stream = 0;
  std::uint64_t seq = 0;
};

enum class ConflictKind {
  Gap,            // delivered ahead of a not-yet-delivered predecessor
  OutOfWindow,    // cannot be disambiguated within the window
  SeqOutOfRange,  // raw sequence number >= modulus
  Parse,          // malformed log line
};

std::string to_string(ConflictKind kind);

struct Conflict {
  ConflictKind kind = ConflictKind::Gap;
  Packet packet{};
  std::uint64_t expected_next = 0;  // extended next-expected for the stream
  std::string detail;
};

struct Stats {
  std::uint64_t packets = 0;
  std::uint64_t delivered = 0;        // first-time, in-order deliveries
  std::uint64_t retransmissions = 0;  // already-delivered duplicates (ignored)
};

// Verifies a packet log packet by packet. Per stream, deliveries must cover
// the sequence space as a prefix (no gaps); re-deliveries of an
// already-delivered sequence number are retransmissions and do not count as
// new deliveries. Streams are independent: no cross-stream ordering is
// assumed.
class Checker {
 public:
  explicit Checker(Params params);

  // Feeds one packet. Returns the conflict on the first violation (state is
  // left unchanged in that case) or std::nullopt when the packet is
  // acceptable.
  std::optional<Conflict> process(const Packet& packet);

  const Stats& stats() const { return stats_; }
  std::uint64_t streams() const { return next_.size(); }
  // Extended next-expected sequence number for a stream (0 if unseen).
  std::uint64_t next_expected(std::uint64_t stream) const;

 private:
  Params params_;
  std::unordered_map<std::uint64_t, std::uint64_t> next_;  // stream -> extended next
  Stats stats_;
};

// Parses one log line into a Packet. Blank lines and lines whose first
// non-space character is '#' yield std::nullopt with `error` left empty;
// malformed lines yield std::nullopt with `error` set.
std::optional<Packet> parse_line(std::uint64_t line_no, const std::string& line,
                                 std::string& error);

}  // namespace seqcheck
