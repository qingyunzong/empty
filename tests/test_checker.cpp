// Unit tests for the checker plus an exhaustive small-window cross-check of
// every possible log against an independently written reference.

#include <cstdint>
#include <iostream>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "checker.hpp"

namespace {

int failures = 0;

#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      ++failures;                                                          \
      std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": " #cond    \
                << "\n";                                                   \
    }                                                                      \
  } while (0)

using Log = std::vector<std::pair<std::uint64_t, std::uint64_t>>;  // (stream, seq)

struct Verdict {
  bool ok = true;
  std::size_t conflict_index = 0;  // index into the log, valid when !ok
  seqcheck::ConflictKind kind = seqcheck::ConflictKind::Gap;
  seqcheck::Stats stats{};
};

Verdict run_checker(const seqcheck::Params& params, const Log& log) {
  seqcheck::Checker checker(params);
  for (std::size_t i = 0; i < log.size(); ++i) {
    const seqcheck::Packet packet{i + 1, "", log[i].first, log[i].second};
    if (const auto conflict = checker.process(packet)) {
      return {false, i, conflict->kind, checker.stats()};
    }
  }
  return {true, log.size(), {}, checker.stats()};
}

// Reference implementation, deliberately written differently from Checker:
// it enumerates the candidate extended sequence numbers near the expected
// position and tracks the delivered prefix explicitly.
Verdict run_reference(const seqcheck::Params& params, const Log& log) {
  std::unordered_map<std::uint64_t, std::uint64_t> next;  // stream -> extended next
  std::unordered_map<std::uint64_t, std::unordered_set<std::uint64_t>> delivered;
  seqcheck::Stats stats;
  for (std::size_t i = 0; i < log.size(); ++i) {
    const auto [stream, seq] = log[i];
    ++stats.packets;
    if (seq >= params.modulus) {
      return {false, i, seqcheck::ConflictKind::SeqOutOfRange, stats};
    }
    const std::uint64_t n0 = next[stream];  // 0 for unseen streams
    // Candidates congruent to seq (mod modulus) closest to n0.
    const std::uint64_t base = n0 - n0 % params.modulus + seq;
    std::vector<std::uint64_t> candidates{base, base + params.modulus};
    if (base >= params.modulus) candidates.push_back(base - params.modulus);
    std::uint64_t best = 0;
    std::uint64_t best_dist = ~std::uint64_t{0};
    for (const std::uint64_t n : candidates) {
      const std::uint64_t dist = n >= n0 ? n - n0 : n0 - n;
      if (dist < best_dist || (dist == best_dist && n > best)) {  // tie -> future
        best = n;
        best_dist = dist;
      }
    }
    if (best_dist > params.window) {
      return {false, i, seqcheck::ConflictKind::OutOfWindow, stats};
    }
    if (best == n0) {
      next[stream] = n0 + 1;
      delivered[stream].insert(n0);
      ++stats.delivered;
    } else if (best < n0) {
      if (!delivered[stream].count(best)) {  // must not happen under prefix order
        return {false, i, seqcheck::ConflictKind::OutOfWindow, stats};
      }
      ++stats.retransmissions;  // retransmission: not a new delivery
    } else {
      return {false, i, seqcheck::ConflictKind::Gap, stats};
    }
  }
  return {true, log.size(), {}, stats};
}

// ---------------------------------------------------------------- unit tests

void test_in_order() {
  const auto v = run_checker({8, 4}, {{0, 0}, {0, 1}, {0, 2}, {0, 3}});
  CHECK(v.ok);
  CHECK(v.stats.delivered == 4);
  CHECK(v.stats.retransmissions == 0);
}

void test_retransmission_ignored() {
  const auto v = run_checker({8, 4}, {{0, 0}, {0, 1}, {0, 1}, {0, 2}, {0, 0}, {0, 3}});
  CHECK(v.ok);
  CHECK(v.stats.delivered == 4);
  CHECK(v.stats.retransmissions == 2);
}

void test_gap_conflict() {
  const auto v = run_checker({8, 4}, {{0, 0}, {0, 2}});
  CHECK(!v.ok);
  CHECK(v.conflict_index == 1);
  CHECK(v.kind == seqcheck::ConflictKind::Gap);
}

void test_first_conflict_wins() {
  // Gap at index 1; the later line would be fine on its own.
  const auto v = run_checker({8, 4}, {{0, 0}, {0, 3}, {0, 1}});
  CHECK(!v.ok);
  CHECK(v.conflict_index == 1);
}

void test_wrap_around() {
  const auto v = run_checker(
      {8, 4}, {{0, 0}, {0, 1}, {0, 2}, {0, 3}, {0, 4}, {0, 5}, {0, 6}, {0, 7}, {0, 0}, {0, 1}});
  CHECK(v.ok);
  CHECK(v.stats.delivered == 10);
}

void test_retransmission_across_wrap() {
  // After delivering extended 0..9, raw 7 maps to extended 7: a retransmission.
  const auto v = run_checker(
      {8, 4},
      {{0, 0}, {0, 1}, {0, 2}, {0, 3}, {0, 4}, {0, 5}, {0, 6}, {0, 7}, {0, 0}, {0, 1}, {0, 7}});
  CHECK(v.ok);
  CHECK(v.stats.delivered == 10);
  CHECK(v.stats.retransmissions == 1);
}

void test_cross_stream_unordered() {
  // Interleaved streams: no cross-stream ordering is required.
  const auto v = run_checker(
      {8, 4}, {{0, 0}, {1, 0}, {0, 1}, {1, 1}, {2, 0}, {0, 2}, {1, 0}, {2, 1}});
  CHECK(v.ok);
  CHECK(v.stats.delivered == 7);
  CHECK(v.stats.retransmissions == 1);
}

void test_out_of_window() {
  // window 2, modulus 8: raw 5 is 3 behind and 5 ahead of expected 0.
  const auto v = run_checker({8, 2}, {{0, 0}, {0, 1}, {0, 5}});
  CHECK(!v.ok);
  CHECK(v.conflict_index == 2);
  CHECK(v.kind == seqcheck::ConflictKind::OutOfWindow);
}

void test_seq_out_of_range() {
  const auto v = run_checker({8, 4}, {{0, 0}, {0, 8}});
  CHECK(!v.ok);
  CHECK(v.kind == seqcheck::ConflictKind::SeqOutOfRange);
}

void test_tie_resolves_to_future() {
  // modulus 8, window 4: raw 2 is exactly 4 behind and 4 ahead of expected 6.
  const auto v = run_checker(
      {8, 4}, {{0, 0}, {0, 1}, {0, 2}, {0, 3}, {0, 4}, {0, 5}, {0, 2}});
  CHECK(!v.ok);
  CHECK(v.kind == seqcheck::ConflictKind::Gap);
}

void test_parse_line() {
  std::string error;
  CHECK(!seqcheck::parse_line(1, "", error) && error.empty());
  CHECK(!seqcheck::parse_line(2, "   # comment", error) && error.empty());
  const auto ok = seqcheck::parse_line(3, " 7  42 ", error);
  CHECK(ok && ok->stream == 7 && ok->seq == 42 && ok->line_no == 3);
  CHECK(ok && ok->raw == " 7  42 ");
  CHECK(!seqcheck::parse_line(4, "1", error) && !error.empty());
  CHECK(!seqcheck::parse_line(5, "1 2 3", error) && !error.empty());
  CHECK(!seqcheck::parse_line(6, "a b", error) && !error.empty());
  CHECK(!seqcheck::parse_line(7, "-1 2", error) && !error.empty());
  CHECK(!seqcheck::parse_line(8, "1 2x", error) && !error.empty());
}

void test_conflict_evidence() {
  seqcheck::Checker checker({8, 4});
  std::string error;
  std::optional<seqcheck::Conflict> conflict;
  const char* lines[] = {"0 0", "0 1", "0 5"};
  for (std::uint64_t i = 0; i < 3; ++i) {
    const auto packet = seqcheck::parse_line(i + 1, lines[i], error);
    CHECK(packet.has_value());
    conflict = checker.process(*packet);
  }
  CHECK(conflict.has_value());
  CHECK(conflict->kind == seqcheck::ConflictKind::Gap);
  CHECK(conflict->packet.line_no == 3);
  CHECK(conflict->packet.raw == "0 5");
  CHECK(conflict->expected_next == 2);
}

// ------------------------------------------- exhaustive small-window check

// Enumerates every log of length `length` over `streams` streams and raw
// sequence numbers in [0, modulus), and cross-checks the checker against the
// reference: same verdict, same first-conflict position and kind, and same
// delivery/retransmission counts.
void exhaustive(std::uint64_t modulus, std::uint64_t window, std::uint64_t streams,
                std::size_t length) {
  const seqcheck::Params params{modulus, window};
  const std::uint64_t alphabet = streams * modulus;
  std::uint64_t total = 1;
  for (std::size_t i = 0; i < length; ++i) total *= alphabet;
  Log log(length);
  for (std::uint64_t t = 0; t < total; ++t) {
    std::uint64_t x = t;
    for (std::size_t i = 0; i < length; ++i) {
      const std::uint64_t sym = x % alphabet;
      x /= alphabet;
      log[i] = {sym / modulus, sym % modulus};
    }
    const auto a = run_checker(params, log);
    const auto b = run_reference(params, log);
    if (a.ok != b.ok || a.conflict_index != b.conflict_index ||
        (!a.ok && a.kind != b.kind) ||
        (a.ok && (a.stats.delivered != b.stats.delivered ||
                  a.stats.retransmissions != b.stats.retransmissions))) {
      ++failures;
      std::cerr << "FAIL exhaustive modulus=" << modulus << " window=" << window
                << " streams=" << streams << " log=";
      for (const auto& [s, q] : log) std::cerr << "(" << s << "," << q << ")";
      std::cerr << "\n";
      return;
    }
  }
}

void test_exhaustive_small_windows() {
  exhaustive(2, 1, 1, 12);  // 2^12 logs
  exhaustive(4, 2, 1, 6);   // 4^6 logs
  exhaustive(8, 4, 1, 4);   // 8^4 logs, ties at window == modulus/2
  exhaustive(6, 2, 1, 5);   // window < modulus/2: exercises out-of-window
  exhaustive(4, 2, 2, 5);   // 8^5 logs, two interleaved streams
  exhaustive(2, 1, 3, 6);   // 6^6 logs, three streams
  exhaustive(5, 2, 2, 4);   // 10^4 logs, odd modulus
}

}  // namespace

int main() {
  test_in_order();
  test_retransmission_ignored();
  test_gap_conflict();
  test_first_conflict_wins();
  test_wrap_around();
  test_retransmission_across_wrap();
  test_cross_stream_unordered();
  test_out_of_window();
  test_seq_out_of_range();
  test_tie_resolves_to_future();
  test_parse_line();
  test_conflict_evidence();
  test_exhaustive_small_windows();

  if (failures != 0) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "all checks passed\n";
  return 0;
}
