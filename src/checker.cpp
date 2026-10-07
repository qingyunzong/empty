#include "checker.hpp"

#include <charconv>
#include <sstream>

namespace seqcheck {

std::string to_string(ConflictKind kind) {
  switch (kind) {
    case ConflictKind::Gap:
      return "gap";
    case ConflictKind::OutOfWindow:
      return "out-of-window";
    case ConflictKind::SeqOutOfRange:
      return "seq-out-of-range";
    case ConflictKind::Parse:
      return "parse";
  }
  return "unknown";
}

Checker::Checker(Params params) : params_(params) {}

std::optional<Conflict> Checker::process(const Packet& packet) {
  ++stats_.packets;
  const std::uint64_t modulus = params_.modulus;
  const std::uint64_t window = params_.window;

  if (packet.seq >= modulus) {
    return Conflict{ConflictKind::SeqOutOfRange, packet, next_expected(packet.stream),
                    "seq " + std::to_string(packet.seq) + " is outside modulus " +
                        std::to_string(modulus)};
  }

  std::uint64_t& next = next_[packet.stream];  // extended, starts at 0
  // Forward distance from the next-expected position, in [0, modulus).
  const std::uint64_t fwd = (packet.seq + modulus - next % modulus) % modulus;

  if (fwd == 0) {
    ++next;  // in-order first delivery: extends the delivered prefix
    ++stats_.delivered;
    return std::nullopt;
  }
  if (fwd <= window) {
    // Ahead of the prefix: a predecessor is still missing.
    return Conflict{ConflictKind::Gap, packet, next,
                    "seq maps " + std::to_string(fwd) +
                        " ahead of next expected; prefix order violated"};
  }
  const std::uint64_t back = modulus - fwd;  // distance behind, in (0, modulus)
  if (back <= window && next >= back) {
    // Already delivered (delivery is a prefix, so everything behind `next`
    // was delivered): a retransmission, not a new delivery.
    ++stats_.retransmissions;
    return std::nullopt;
  }
  return Conflict{ConflictKind::OutOfWindow, packet, next,
                  "seq cannot be disambiguated within window " +
                      std::to_string(window)};
}

std::uint64_t Checker::next_expected(std::uint64_t stream) const {
  const auto it = next_.find(stream);
  return it == next_.end() ? 0 : it->second;
}

std::optional<Packet> parse_line(std::uint64_t line_no, const std::string& line,
                                 std::string& error) {
  error.clear();
  const auto first = line.find_first_not_of(" \t\r\n");
  if (first == std::string::npos || line[first] == '#') {
    return std::nullopt;
  }
  std::istringstream in(line);
  std::string tok_stream, tok_seq, extra;
  if (!(in >> tok_stream >> tok_seq) || (in >> extra)) {
    error = "expected exactly 2 fields: <stream> <seq>";
    return std::nullopt;
  }
  const auto parse_u64 = [](const std::string& tok, std::uint64_t& out) {
    if (tok.empty() || tok.front() == '-' || tok.front() == '+') {
      return false;
    }
    const auto res = std::from_chars(tok.data(), tok.data() + tok.size(), out);
    return res.ec == std::errc{} && res.ptr == tok.data() + tok.size();
  };
  Packet packet;
  packet.line_no = line_no;
  packet.raw = line;
  if (!parse_u64(tok_stream, packet.stream) || !parse_u64(tok_seq, packet.seq)) {
    error = "fields must be unsigned integers";
    return std::nullopt;
  }
  return packet;
}

}  // namespace seqcheck
