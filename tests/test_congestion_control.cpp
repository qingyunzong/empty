#include "dlks_formal.hpp"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string_view>
#include <vector>

namespace {

using dlks_formal::AckEvent;
using dlks_formal::Bytes;
using dlks_formal::ChangeReason;
using dlks_formal::CongestionConfig;
using dlks_formal::CongestionController;
using dlks_formal::CongestionState;
using dlks_formal::SackBlock;

int failures = 0;

void check(bool condition, std::string_view expression, int line) {
  if (!condition) {
    std::cerr << "line " << line << ": check failed: " << expression << '\n';
    ++failures;
  }
}

#define CHECK(expr) check((expr), #expr, __LINE__)

void check_u64(const char* what, std::uint64_t actual, std::uint64_t expected,
               int line) {
  if (actual != expected) {
    std::cerr << "line " << line << ": " << what << " = " << actual
              << ", expected " << expected << '\n';
    ++failures;
  }
}

#define CHECK_U64(actual, expected) \
  check_u64(#actual, (actual), (expected), __LINE__)

void check_state(const char* what, CongestionState actual,
                 CongestionState expected, int line) {
  if (actual != expected) {
    std::cerr << "line " << line << ": " << what << " = "
              << dlks_formal::to_string(actual) << ", expected "
              << dlks_formal::to_string(expected) << '\n';
    ++failures;
  }
}

#define CHECK_STATE(actual, expected) \
  check_state(#actual, (actual), (expected), __LINE__)

// ---------------------------------------------------------------------------
// Fixed deterministic trace and its specification-state table
// ---------------------------------------------------------------------------

enum class Op { Send, Ack, DuplicateAck, Timeout };

struct TraceStep {
  Op op;
  std::uint64_t value;  // bytes for Send, sequence for Ack
  std::uint64_t expect_cwnd;
  std::uint64_t expect_ssthresh;
  CongestionState expect_state;
  std::uint64_t expect_flight;
  std::uint32_t expect_dupacks;
};

void test_fixed_trace() {
  CongestionConfig cfg;
  cfg.mss = 1000;
  cfg.initial_cwnd = 1000;
  cfg.initial_ssthresh = 8000;
  CongestionController cc(cfg);

  // Sequence numbers are byte offsets.  The table is the normative model:
  // cwnd grows by min(newly ACKed, MSS) in slow start, by
  // MSS*MSS/cwnd in congestion avoidance, halves FlightSize on loss, and
  // returns to congestion avoidance at ssthresh after a full recovery ACK.
  const TraceStep trace[] = {
      {Op::Send, 1000, 1000, 8000, CongestionState::SlowStart, 1000, 0},
      {Op::Ack, 1000, 2000, 8000, CongestionState::SlowStart, 0, 0},
      {Op::Send, 2000, 2000, 8000, CongestionState::SlowStart, 2000, 0},
      {Op::Ack, 3000, 3000, 8000, CongestionState::SlowStart, 0, 0},
      {Op::Send, 3000, 3000, 8000, CongestionState::SlowStart, 3000, 0},
      {Op::Ack, 6000, 4000, 8000, CongestionState::SlowStart, 0, 0},
      {Op::Send, 4000, 4000, 8000, CongestionState::SlowStart, 4000, 0},
      {Op::Ack, 10000, 5000, 8000, CongestionState::SlowStart, 0, 0},
      {Op::Send, 5000, 5000, 8000, CongestionState::SlowStart, 5000, 0},
      {Op::Ack, 11000, 6000, 8000, CongestionState::SlowStart, 4000, 0},
      {Op::Ack, 12000, 7000, 8000, CongestionState::SlowStart, 3000, 0},
      {Op::Ack, 13000, 8000, 8000, CongestionState::CongestionAvoidance, 2000,
       0},
      {Op::Ack, 14000, 8125, 8000, CongestionState::CongestionAvoidance, 1000,
       0},
      {Op::Ack, 15000, 8248, 8000, CongestionState::CongestionAvoidance, 0, 0},
      {Op::Send, 5000, 8248, 8000, CongestionState::CongestionAvoidance, 5000,
       0},
      {Op::DuplicateAck, 0, 8248, 8000,
       CongestionState::CongestionAvoidance, 5000, 1},
      {Op::DuplicateAck, 0, 8248, 8000,
       CongestionState::CongestionAvoidance, 5000, 2},
      {Op::DuplicateAck, 0, 5500, 2500, CongestionState::FastRecovery, 5000, 3},
      {Op::DuplicateAck, 0, 6500, 2500, CongestionState::FastRecovery, 5000, 4},
      // Reordered, stale ACK below snd_una: no window movement.
      {Op::Ack, 14000, 6500, 2500, CongestionState::FastRecovery, 5000, 4},
      // NewReno partial ACKs.
      {Op::Ack, 17000, 5500, 2500, CongestionState::FastRecovery, 3000, 0},
      {Op::Ack, 18000, 5500, 2500, CongestionState::FastRecovery, 2000, 0},
      // Full recovery ACK: cwnd = ssthresh and state = congestion avoidance.
      {Op::Ack, 20000, 2500, 2500, CongestionState::CongestionAvoidance, 0, 0},
      {Op::Send, 2500, 2500, 2500, CongestionState::CongestionAvoidance, 2500,
       0},
      {Op::Ack, 21000, 2900, 2500, CongestionState::CongestionAvoidance, 1500,
       0},
      {Op::Timeout, 0, 1000, 2000, CongestionState::SlowStart, 1500, 0},
      {Op::Ack, 22500, 2000, 2000, CongestionState::CongestionAvoidance, 0, 0},
      {Op::Send, 2000, 2000, 2000, CongestionState::CongestionAvoidance, 2000,
       0},
      {Op::Ack, 24500, 2500, 2000, CongestionState::CongestionAvoidance, 0, 0},
  };

  std::uint64_t send_seq = 0;
  for (const TraceStep& step : trace) {
    switch (step.op) {
      case Op::Send:
        CHECK(cc.can_send(step.value));
        cc.on_packet_sent(send_seq, step.value);
        send_seq += step.value;
        break;
      case Op::Ack:
        cc.on_ack(step.value);
        break;
      case Op::DuplicateAck:
        cc.on_duplicate_ack();
        break;
      case Op::Timeout:
        cc.on_timeout();
        break;
    }

    CHECK_U64(cc.cwnd(), step.expect_cwnd);
    CHECK_U64(cc.ssthresh(), step.expect_ssthresh);
    CHECK_STATE(cc.state(), step.expect_state);
    CHECK_U64(cc.bytes_in_flight(), step.expect_flight);
    CHECK_U64(cc.duplicate_acks(), step.expect_dupacks);
    // The no-oversend invariant at every instant of the trace.
    if (cc.bytes_in_flight() >= cc.cwnd()) {
      CHECK(!cc.can_send(1));
    }
  }

  // Seventeen value-changing transitions, in order.
  struct ExpectedChange {
    std::uint64_t old_cwnd;
    std::uint64_t new_cwnd;
    std::uint64_t old_ssthresh;
    std::uint64_t new_ssthresh;
    CongestionState old_state;
    CongestionState new_state;
    ChangeReason reason;
    std::uint64_t ack;
    std::uint32_t dupacks;
  };
  const ExpectedChange expected[] = {
      {1000, 2000, 8000, 8000, CongestionState::SlowStart,
       CongestionState::SlowStart, ChangeReason::Acknowledgment, 1000, 0},
      {2000, 3000, 8000, 8000, CongestionState::SlowStart,
       CongestionState::SlowStart, ChangeReason::Acknowledgment, 3000, 0},
      {3000, 4000, 8000, 8000, CongestionState::SlowStart,
       CongestionState::SlowStart, ChangeReason::Acknowledgment, 6000, 0},
      {4000, 5000, 8000, 8000, CongestionState::SlowStart,
       CongestionState::SlowStart, ChangeReason::Acknowledgment, 10000, 0},
      {5000, 6000, 8000, 8000, CongestionState::SlowStart,
       CongestionState::SlowStart, ChangeReason::Acknowledgment, 11000, 0},
      {6000, 7000, 8000, 8000, CongestionState::SlowStart,
       CongestionState::SlowStart, ChangeReason::Acknowledgment, 12000, 0},
      {7000, 8000, 8000, 8000, CongestionState::SlowStart,
       CongestionState::CongestionAvoidance, ChangeReason::Acknowledgment,
       13000, 0},
      {8000, 8125, 8000, 8000, CongestionState::CongestionAvoidance,
       CongestionState::CongestionAvoidance, ChangeReason::Acknowledgment,
       14000, 0},
      {8125, 8248, 8000, 8000, CongestionState::CongestionAvoidance,
       CongestionState::CongestionAvoidance, ChangeReason::Acknowledgment,
       15000, 0},
      {8248, 5500, 8000, 2500, CongestionState::CongestionAvoidance,
       CongestionState::FastRecovery, ChangeReason::FastRetransmit, 15000, 3},
      {5500, 6500, 2500, 2500, CongestionState::FastRecovery,
       CongestionState::FastRecovery, ChangeReason::DuplicateAcknowledgment,
       15000, 4},
      {6500, 5500, 2500, 2500, CongestionState::FastRecovery,
       CongestionState::FastRecovery, ChangeReason::PartialAcknowledgment,
       17000, 0},
      {5500, 2500, 2500, 2500, CongestionState::FastRecovery,
       CongestionState::CongestionAvoidance, ChangeReason::RecoveryExit,
       20000, 0},
      {2500, 2900, 2500, 2500, CongestionState::CongestionAvoidance,
       CongestionState::CongestionAvoidance, ChangeReason::Acknowledgment,
       21000, 0},
      {2900, 1000, 2500, 2000, CongestionState::CongestionAvoidance,
       CongestionState::SlowStart, ChangeReason::Timeout, 21000, 0},
      {1000, 2000, 2000, 2000, CongestionState::SlowStart,
       CongestionState::CongestionAvoidance, ChangeReason::Acknowledgment,
       22500, 0},
      {2000, 2500, 2000, 2000, CongestionState::CongestionAvoidance,
       CongestionState::CongestionAvoidance, ChangeReason::Acknowledgment,
       24500, 0},
  };

  const auto& history = cc.history();
  CHECK_U64(history.size(), std::size(expected));
  const std::size_t common =
      std::min<std::size_t>(history.size(), std::size(expected));
  for (std::size_t i = 0; i < common; ++i) {
    CHECK_U64(history[i].sequence, i + 1);
    CHECK_U64(history[i].index, i + 1);
    CHECK_U64(history[i].old_cwnd, expected[i].old_cwnd);
    CHECK_U64(history[i].new_cwnd, expected[i].new_cwnd);
    CHECK_U64(history[i].old_ssthresh, expected[i].old_ssthresh);
    CHECK_U64(history[i].new_ssthresh, expected[i].new_ssthresh);
    CHECK_STATE(history[i].old_state, expected[i].old_state);
    CHECK_STATE(history[i].new_state, expected[i].new_state);
    CHECK(history[i].reason == expected[i].reason);
    CHECK(history[i].cause == expected[i].reason);
    CHECK_U64(history[i].ack, expected[i].ack);
    CHECK_U64(history[i].duplicate_acks, expected[i].dupacks);
    CHECK(history[i].timestamp == history[i].time);
  }

  // Every record links exactly to the previous one.
  for (std::size_t i = 1; i < history.size(); ++i) {
    CHECK_U64(history[i].old_cwnd, history[i - 1].new_cwnd);
    CHECK_U64(history[i].old_ssthresh, history[i - 1].new_ssthresh);
    CHECK(history[i].old_state == history[i - 1].new_state);
    CHECK(history[i].timestamp >= history[i - 1].timestamp);
  }
}

// ---------------------------------------------------------------------------
// SACK scoreboard, duplicate-ACK accounting and pipe/no-oversend behaviour
// ---------------------------------------------------------------------------

void test_sack_and_pipe() {
  CongestionConfig cfg;
  cfg.mss = 1000;
  cfg.initial_cwnd = 10000;
  cfg.initial_ssthresh = 100000;
  CongestionController cc(cfg);

  CHECK(cc.on_packet_sent(0, 10000));
  CHECK_U64(cc.bytes_in_flight(), 10000);
  CHECK_U64(cc.pipe(), 10000);

  const SackBlock one[]{SackBlock{1000, 4000}};
  cc.on_ack(0, one);
  CHECK_U64(cc.duplicate_acks(), 1);  // one ACK event, not three segments
  CHECK_U64(cc.sacked_bytes(), 3000);
  CHECK_U64(cc.pipe(), 7000);
  CHECK_U64(cc.available_window(), 3000);

  // Repeating the same ACK event is still one indication, never two.
  cc.on_ack(0, one);
  CHECK_U64(cc.duplicate_acks(), 2);
  CHECK_U64(cc.sacked_bytes(), 3000);

  const SackBlock two[]{SackBlock{1000, 6000}};
  cc.on_ack(0, two);
  CHECK_U64(cc.duplicate_acks(), 3);
  CHECK(cc.in_fast_recovery());
  CHECK_U64(cc.ssthresh(), 2500);  // pipe = 10000 - 5000 = 5000
  CHECK_U64(cc.cwnd(), 5500);
  CHECK_U64(cc.pipe(), 5000);

  // Only 500 bytes remain inside the inflated window.
  CHECK_U64(cc.available_window(), 500);
  CHECK(cc.can_send(500));
  CHECK(!cc.try_send(501));
  CHECK(cc.try_send(500));
  CHECK_U64(cc.pipe(), 5500);
  CHECK(!cc.can_send(1));

  // Partial ACK through the first SACK hole deflates the recovery window.
  cc.on_ack(6000);
  CHECK(cc.in_fast_recovery());
  CHECK_U64(cc.cwnd(), 1000);
  CHECK_U64(cc.pipe(), 4500);
  CHECK(!cc.can_send(1));

  // A stale ACK below snd_una is ignored completely.
  const std::uint64_t before_cwnd = cc.cwnd();
  const std::size_t before_log = cc.history().size();
  cc.on_ack(1000);
  CHECK_U64(cc.cwnd(), before_cwnd);
  CHECK_U64(cc.history().size(), before_log);

  // Full ACK exits to congestion avoidance at ssthresh.
  cc.on_ack(10000);
  CHECK(cc.in_congestion_avoidance());
  CHECK_U64(cc.cwnd(), 2500);
  CHECK_U64(cc.bytes_in_flight(), 500);
  CHECK_U64(cc.pipe(), 500);

  cc.on_ack(10500);
  CHECK_U64(cc.cwnd(), 2900);
  CHECK_U64(cc.bytes_in_flight(), 0);

  // The optional RFC 6675 mode lets newly SACKed segments feed the count.
  CongestionConfig aggressive = cfg;
  aggressive.count_sacked_segments_as_dupacks = true;
  CongestionController fast(aggressive);
  CHECK(fast.on_packet_sent(0, 10000));
  fast.on_ack(0, one);
  CHECK_U64(fast.duplicate_acks(), 3);
  CHECK(fast.in_fast_recovery());

  // SACK blocks carried by an advancing cumulative ACK update the scoreboard
  // immediately, so the pipe estimate never includes selectively ACKed data.
  CongestionController advancing(cfg);
  CHECK(advancing.on_packet_sent(0, 10000));
  const SackBlock attached[]{SackBlock{4000, 6000}};
  advancing.on_ack(2000, attached);
  CHECK_U64(advancing.bytes_in_flight(), 8000);
  CHECK_U64(advancing.sacked_bytes(), 2000);
  CHECK_U64(advancing.pipe(), 6000);
}

// ---------------------------------------------------------------------------
// RTT estimator (RFC 6298)
// ---------------------------------------------------------------------------

void test_rtt_estimator() {
  CongestionConfig cfg;
  cfg.mss = 1000;
  cfg.initial_cwnd = 1000;
  CongestionController cc(cfg);

  cc.on_rtt_sample(100000);
  CHECK_U64(cc.srtt_us(), 100000);
  CHECK_U64(cc.rttvar_us(), 50000);
  CHECK_U64(cc.rto_us(), 300000);

  cc.on_rtt_sample(200000);
  CHECK_U64(cc.srtt_us(), 112500);
  CHECK_U64(cc.rttvar_us(), 62500);
  CHECK_U64(cc.rto_us(), 362500);

  // Karn ambiguity: the invalid sample changes nothing.
  cc.on_rtt_sample(900000, false);
  CHECK_U64(cc.srtt_us(), 112500);

  // An ACK event can carry a sample.
  AckEvent event;
  event.ack = 0;
  event.rtt_us = 120000;
  event.has_timestamp = true;
  event.timestamp = 42;
  cc.on_ack(event);
  CHECK_U64(cc.srtt_us(), (7 * 112500 + 120000) / 8);
}

// ---------------------------------------------------------------------------
// Deterministic fuzz trace against an independently coded specification model
// ---------------------------------------------------------------------------

struct ReferenceModel {
  std::uint64_t mss;
  std::uint64_t cwnd;
  std::uint64_t ssthresh;
  std::uint64_t last_ack = 0;
  std::uint64_t flight = 0;
  std::uint64_t recover = 0;
  std::uint32_t dupacks = 0;
  CongestionState state = CongestionState::SlowStart;

  bool can_send(std::uint64_t bytes) const {
    return bytes <= cwnd && flight <= cwnd - bytes;
  }

  void send(std::uint64_t bytes) { flight += bytes; }

  void ack(std::uint64_t value) {
    if (value < last_ack) return;
    if (value == last_ack) {
      ++dupacks;
      if (state == CongestionState::FastRecovery) {
        cwnd += mss;
      } else if (dupacks >= 3) {
        const std::uint64_t f = flight == 0 ? cwnd : flight;
        ssthresh = std::max(f / 2, 2 * mss);
        cwnd = ssthresh + 3 * mss;
        recover = last_ack + f;
        state = CongestionState::FastRecovery;
      }
      return;
    }

    const std::uint64_t newly = value - last_ack;
    last_ack = value;
    flight = flight > newly ? flight - newly : 0;
    dupacks = 0;

    if (state == CongestionState::FastRecovery) {
      if (value >= recover) {
        cwnd = ssthresh;
        state = CongestionState::CongestionAvoidance;
        recover = last_ack;
      } else {
        cwnd = std::max(mss, cwnd > newly ? cwnd - newly : 0) + mss;
      }
      return;
    }

    if (cwnd < ssthresh) {
      cwnd += std::min(newly, mss);
      if (cwnd >= ssthresh) state = CongestionState::CongestionAvoidance;
    } else {
      cwnd += std::max<std::uint64_t>(1, mss * mss / cwnd);
    }
  }

  void loss() {
    if (state == CongestionState::FastRecovery) return;
    const std::uint64_t f = flight == 0 ? cwnd : flight;
    ssthresh = std::max(f / 2, 2 * mss);
    cwnd = ssthresh + 3 * mss;
    recover = last_ack + f;
    state = CongestionState::FastRecovery;
  }

  void timeout() {
    const std::uint64_t f = flight == 0 ? cwnd : flight;
    ssthresh = std::max(f / 2, 2 * mss);
    cwnd = mss;
    state = CongestionState::SlowStart;
    dupacks = 0;
    recover = 0;
  }
};

void compare_with_reference(const CongestionController& cc,
                            const ReferenceModel& ref, std::uint64_t step) {
  if (cc.cwnd() != ref.cwnd || cc.ssthresh() != ref.ssthresh ||
      cc.state() != ref.state || cc.bytes_in_flight() != ref.flight ||
      cc.duplicate_acks() != ref.dupacks) {
    std::cerr << "deterministic trace mismatch at event " << step << ":\n"
              << "  cwnd " << cc.cwnd() << " vs " << ref.cwnd << '\n'
              << "  ssthresh " << cc.ssthresh() << " vs " << ref.ssthresh
              << '\n'
              << "  state " << dlks_formal::to_string(cc.state()) << " vs "
              << dlks_formal::to_string(ref.state) << '\n'
              << "  flight " << cc.bytes_in_flight() << " vs " << ref.flight
              << '\n'
              << "  dupacks " << cc.duplicate_acks() << " vs " << ref.dupacks
              << '\n';
    ++failures;
  }
}

void test_deterministic_fuzz_trace() {
  CongestionConfig cfg;
  cfg.mss = 1000;
  cfg.initial_cwnd = 1000;
  cfg.initial_ssthresh = 12000;
  CongestionController cc(cfg);

  ReferenceModel ref{1000, 1000, 12000};

  std::uint64_t rng = 0x9e3779b97f4a7c15ULL;
  auto next = [&rng]() {
    rng = rng * 6364136223846793005ULL + 1442695040888963407ULL;
    return rng >> 33;
  };

  for (std::uint64_t step = 0; step < 4000; ++step) {
    const std::uint64_t action = next() % 100;
    if (action < 35) {
      std::uint64_t bytes = std::min<std::uint64_t>(cfg.mss, cc.available_window());
      if (bytes == 0) bytes = 1;
      if (ref.can_send(bytes)) {
        CHECK(cc.try_send(bytes));
        ref.send(bytes);
      } else {
        CHECK(!cc.try_send(bytes));
      }
    } else if (action < 72) {
      if (ref.flight == 0) {
        CHECK(cc.try_send(cfg.mss));
        ref.send(cfg.mss);
      } else {
        const std::uint64_t advance = 1 + next() % ref.flight;
        const std::uint64_t ack = ref.last_ack + advance;
        cc.on_ack(ack);
        ref.ack(ack);
      }
    } else if (action < 82) {
      cc.on_duplicate_ack();
      ref.ack(ref.last_ack);
    } else if (action < 90) {
      if (ref.last_ack > 0) {
        const std::uint64_t back = 1 + next() % ref.last_ack;
        const std::uint64_t stale = ref.last_ack - back;
        const std::uint64_t before_cwnd = cc.cwnd();
        cc.on_ack(stale);
        ref.ack(stale);
        CHECK_U64(cc.cwnd(), before_cwnd);
      }
    } else if (action < 96) {
      cc.on_loss();
      ref.loss();
    } else {
      cc.on_timeout();
      ref.timeout();
    }

    compare_with_reference(cc, ref, step);
    if (cc.available_window() > 0) {
      CHECK(cc.can_send(cc.available_window()));
      CHECK(!cc.can_send(cc.available_window() + 1));
    }
  }

  // Log integrity over the whole trace.
  const auto& history = cc.history();
  for (std::size_t i = 0; i < history.size(); ++i) {
    CHECK_U64(history[i].sequence, i + 1);
    CHECK(history[i].old_cwnd != history[i].new_cwnd ||
          history[i].old_ssthresh != history[i].new_ssthresh ||
          history[i].old_state != history[i].new_state);
    if (i > 0) {
      CHECK_U64(history[i].old_cwnd, history[i - 1].new_cwnd);
      CHECK_U64(history[i].old_ssthresh, history[i - 1].new_ssthresh);
      CHECK(history[i].old_state == history[i - 1].new_state);
    }
  }
}

void test_initial_window_and_state_names() {
  CongestionController standard(1460);
  CHECK_U64(standard.cwnd(), 14600);
  CHECK_U64(standard.ssthresh(), dlks_formal::kInfiniteWindow);
  CHECK(standard.in_slow_start());
  CHECK(standard.state_name() == "SlowStart");

  CongestionController small(536);
  CHECK_U64(small.cwnd(), 5360);

  CongestionController large(9000);
  CHECK_U64(large.cwnd(), 18000);
}

}  // namespace

int main() {
  test_fixed_trace();
  test_sack_and_pipe();
  test_rtt_estimator();
  test_deterministic_fuzz_trace();
  test_initial_window_and_state_names();

  if (failures != 0) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "all congestion-control checks passed\n";
  return 0;
}
