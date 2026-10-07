#include "checker.hpp"

#include <cstdlib>
#include <iostream>
#include <random>
#include <sstream>
#include <string>

namespace {

int failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": "    \
                      << #cond << "\n";                                    \
            ++failures;                                                    \
        }                                                                  \
    } while (0)

using seqcheck::Packet;

std::vector<Packet> pkts(std::initializer_list<std::pair<std::uint64_t, std::uint64_t>> in) {
    std::vector<Packet> out;
    std::size_t line = 0;
    for (auto [s, q] : in)
        out.push_back(Packet{s, q, ++line, std::to_string(s) + " " + std::to_string(q)});
    return out;
}

void test_in_order_ok() {
    auto r = seqcheck::check_packets(pkts({{1, 0}, {1, 1}, {1, 2}, {1, 3}}), 16, 8);
    CHECK(!r.conflict);
    CHECK(r.stats.delivered == 4);
    CHECK(r.stats.retrans == 0);
}

void test_retrans_ignored() {
    // Duplicates of already delivered seqs are retransmissions, not conflicts.
    auto r = seqcheck::check_packets(pkts({{1, 0}, {1, 0}, {1, 1}, {1, 0}, {1, 1}, {1, 2}}), 16, 8);
    CHECK(!r.conflict);
    CHECK(r.stats.delivered == 3);
    CHECK(r.stats.retrans == 3);
}

void test_gap_conflict() {
    auto r = seqcheck::check_packets(pkts({{1, 0}, {1, 1}, {1, 3}}), 16, 8);
    CHECK(r.conflict);
    if (r.conflict) {
        CHECK(r.conflict->kind == seqcheck::ConflictKind::Gap);
        CHECK(r.conflict->line_no == 3);
        CHECK(r.conflict->expected == 2);
        CHECK(r.conflict->evidence == "1 3");
    }
    CHECK(r.stats.delivered == 2); // stats stop at first conflict
}

void test_cross_stream_unordered() {
    // Streams interleave freely; each stream keeps its own prefix order.
    auto r = seqcheck::check_packets(
        pkts({{1, 0}, {2, 0}, {2, 1}, {1, 1}, {3, 0}, {2, 2}, {1, 2}}), 16, 8);
    CHECK(!r.conflict);
    CHECK(r.stats.streams == 3);
    CHECK(r.stats.delivered == 7);
}

void test_wraparound() {
    // modulus 4: seq wraps 3 -> 0; absolute delivery keeps counting up.
    auto r = seqcheck::check_packets(
        pkts({{1, 0}, {1, 1}, {1, 2}, {1, 3}, {1, 0}, {1, 1}}), 4, 2);
    CHECK(!r.conflict);
    CHECK(r.stats.delivered == 6);
}

void test_wraparound_retrans() {
    // After wrapping, an old-cycle seq inside the window is a retransmission.
    auto r = seqcheck::check_packets(
        pkts({{1, 0}, {1, 1}, {1, 2}, {1, 3}, {1, 0}, {1, 3}}), 4, 2);
    // last packet: expected abs 5, raw 3 -> candidate abs 3 < 5 -> retrans
    CHECK(!r.conflict);
    CHECK(r.stats.delivered == 5);
    CHECK(r.stats.retrans == 1);
}

void test_unresolvable() {
    // window 1, modulus 4: expected abs 2, raw 0 -> no candidate in [1,3).
    auto r = seqcheck::check_packets(pkts({{1, 0}, {1, 1}, {1, 0}}), 4, 1);
    CHECK(r.conflict);
    if (r.conflict)
        CHECK(r.conflict->kind == seqcheck::ConflictKind::Unresolvable);
}

void test_parse_error_evidence() {
    std::istringstream in("1 0\nbogus line\n1 1\n");
    auto r = seqcheck::check_log(in, 16, 8);
    CHECK(r.conflict);
    if (r.conflict) {
        CHECK(r.conflict->kind == seqcheck::ConflictKind::Parse);
        CHECK(r.conflict->line_no == 2);
        CHECK(r.conflict->evidence == "bogus line");
    }
}

void test_comments_and_blanks() {
    std::istringstream in("# header\n\n1 0  # first\n  2 0\n1 1\n");
    auto r = seqcheck::check_log(in, 16, 8);
    CHECK(!r.conflict);
    CHECK(r.stats.delivered == 3);
}

void test_validate_params() {
    CHECK(seqcheck::validate_params(16, 8).empty());
    CHECK(!seqcheck::validate_params(0, 1).empty());
    CHECK(!seqcheck::validate_params(16, 0).empty());
    CHECK(!seqcheck::validate_params(8, 5).empty()); // 2*5 > 8
}

void test_resolve_candidates() {
    // expected 5, modulus 4, window 2 -> window [3,7): raws 3,0,1,2 -> 3,4,5,6
    CHECK(seqcheck::resolve_candidates(0, 5, 4, 2) == std::vector<std::uint64_t>{4});
    CHECK(seqcheck::resolve_candidates(2, 5, 4, 2) == std::vector<std::uint64_t>{6});
    CHECK(seqcheck::resolve_candidates(3, 5, 4, 2) == std::vector<std::uint64_t>{3});
    // near zero the window clamps at 0
    CHECK(seqcheck::resolve_candidates(1, 0, 4, 2) == std::vector<std::uint64_t>{1});
    CHECK(seqcheck::resolve_candidates(3, 0, 4, 2).empty());
}

// Cross-verify the greedy checker against the exhaustive reference over all
// legal delivery sequences, on random small logs (small modulus/window).
void test_reference_cross_validation() {
    std::mt19937_64 rng(20261007);
    for (int iter = 0; iter < 3000; ++iter) {
        const std::uint64_t modulus = 2 + rng() % 7; // 2..8
        const std::uint64_t window = 1 + rng() % (modulus / 2);
        const std::uint64_t n_streams = 1 + rng() % 3;
        const std::size_t n_packets = 1 + rng() % 24;

        std::vector<Packet> packets;
        packets.reserve(n_packets);
        for (std::size_t i = 0; i < n_packets; ++i) {
            packets.push_back(Packet{rng() % n_streams, rng() % modulus,
                                     i + 1, ""});
        }

        const auto r = seqcheck::check_packets(packets, modulus, window);
        const bool ref = seqcheck::reference_consistent(packets, modulus, window);
        if (!r.conflict != ref) {
            std::cerr << "FAIL cross-validation iter " << iter << " modulus "
                      << modulus << " window " << window << "\nlog:";
            for (const auto& p : packets)
                std::cerr << " (" << p.stream << "," << p.seq << ")";
            std::cerr << "\n";
            ++failures;
        }
    }
}

// Deterministic wrap-heavy cross-validation: mostly well-formed streams with
// occasional injected duplicates/gaps.
void test_reference_cross_validation_wrapping() {
    std::mt19937_64 rng(12345);
    for (int iter = 0; iter < 2000; ++iter) {
        const std::uint64_t modulus = 2 + rng() % 4; // 2..5
        const std::uint64_t window = 1 + rng() % (modulus / 2);
        const std::uint64_t n_streams = 1 + rng() % 2;
        const std::size_t n_packets = 1 + rng() % 30;

        std::vector<std::uint64_t> next(n_streams, 0);
        std::vector<Packet> packets;
        for (std::size_t i = 0; i < n_packets; ++i) {
            const std::uint64_t s = rng() % n_streams;
            const int roll = static_cast<int>(rng() % 10);
            std::uint64_t abs_seq;
            if (roll < 6) {
                abs_seq = next[s]++; // in-order delivery
            } else if (roll < 8 && next[s] > 0) {
                abs_seq = rng() % next[s]; // retransmission
            } else {
                abs_seq = rng() % (next[s] + 3); // possibly a gap
            }
            packets.push_back(Packet{s, abs_seq % modulus, i + 1, ""});
        }

        const auto r = seqcheck::check_packets(packets, modulus, window);
        const bool ref = seqcheck::reference_consistent(packets, modulus, window);
        if (!r.conflict != ref) {
            std::cerr << "FAIL wrap cross-validation iter " << iter
                      << " modulus " << modulus << " window " << window << "\n";
            ++failures;
        }
    }
}

} // namespace

int main() {
    test_in_order_ok();
    test_retrans_ignored();
    test_gap_conflict();
    test_cross_stream_unordered();
    test_wraparound();
    test_wraparound_retrans();
    test_unresolvable();
    test_parse_error_evidence();
    test_comments_and_blanks();
    test_validate_params();
    test_resolve_candidates();
    test_reference_cross_validation();
    test_reference_cross_validation_wrapping();

    if (failures) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all unit tests passed\n";
    return 0;
}
