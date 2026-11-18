#pragma once

// dlks_formal - deterministic, embeddable C++20 congestion control.
//
// The controller implements the Reno / NewReno congestion-control state
// machine described by RFC 5681, RFC 6582 and the SACK scoreboard rules of
// RFC 2018/6675.  Sequence numbers and windows are expressed in bytes.  A
// caller may drive the controller entirely from observable events:
//
//   * on_send()/try_send()       - bytes handed to the network
//   * on_ack()/on_sack()         - cumulative and selective acknowledgements
//   * on_duplicate_ack()         - legacy duplicate ACKs (no SACK information)
//   * on_timeout()               - retransmission timer expiry
//   * on_loss()                  - an explicit fast-retransmit indication
//   * on_rtt_sample()            - an unambiguous RTT measurement
//
// Every change to cwnd, ssthresh or the congestion state is appended to a
// monotonically numbered window-change log.  The log contains the exact
// before/after values, the causing event and the duplicate-ACK count.
//
// The implementation is header-only, performs no I/O, uses no clocks or
// random numbers, and is not thread safe.  A controller instance is fully
// deterministic for a given event sequence.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

namespace dlks_formal {

using SeqNum = std::uint64_t;
using Bytes = std::uint64_t;
using TimePoint = std::uint64_t;

inline constexpr std::uint64_t kMaxWindow =
    std::numeric_limits<std::uint64_t>::max() / 4;
inline constexpr std::uint64_t kInfiniteWindow = kMaxWindow;

// ---------------------------------------------------------------------------
// State and event vocabulary
// ---------------------------------------------------------------------------

enum class CongestionState : std::uint8_t {
  SlowStart = 0,
  CongestionAvoidance = 1,
  FastRecovery = 2,
};

using CcState = CongestionState;
using State = CongestionState;

enum class ChangeReason : std::uint8_t {
  Initialization = 0,
  Acknowledgment,
  DuplicateAcknowledgment,
  SelectiveAcknowledgment,
  FastRetransmit,
  PartialAcknowledgment,
  RecoveryExit,
  Timeout,
  ExplicitLoss,
  Reset,
};

using WindowChangeReason = ChangeReason;
using Cause = ChangeReason;

constexpr std::string_view to_string(CongestionState state) noexcept {
  switch (state) {
    case CongestionState::SlowStart:
      return "SlowStart";
    case CongestionState::CongestionAvoidance:
      return "CongestionAvoidance";
    case CongestionState::FastRecovery:
      return "FastRecovery";
  }
  return "Unknown";
}

constexpr std::string_view to_string(ChangeReason reason) noexcept {
  switch (reason) {
    case ChangeReason::Initialization:
      return "Initialization";
    case ChangeReason::Acknowledgment:
      return "Acknowledgment";
    case ChangeReason::DuplicateAcknowledgment:
      return "DuplicateAcknowledgment";
    case ChangeReason::SelectiveAcknowledgment:
      return "SelectiveAcknowledgment";
    case ChangeReason::FastRetransmit:
      return "FastRetransmit";
    case ChangeReason::PartialAcknowledgment:
      return "PartialAcknowledgment";
    case ChangeReason::RecoveryExit:
      return "RecoveryExit";
    case ChangeReason::Timeout:
      return "Timeout";
    case ChangeReason::ExplicitLoss:
      return "ExplicitLoss";
    case ChangeReason::Reset:
      return "Reset";
  }
  return "Unknown";
}

// ---------------------------------------------------------------------------
// Wire-format helper types
// ---------------------------------------------------------------------------

// Half-open byte range [left, right), as carried by a SACK option.
struct SackBlock {
  SeqNum left = 0;
  SeqNum right = 0;

  constexpr Bytes length() const noexcept {
    return right > left ? right - left : 0;
  }
  constexpr bool empty() const noexcept { return right <= left; }
};

using SackRange = SackBlock;

// A single cumulative ACK observation.  SACK blocks may be supplied in any
// order; the controller merges and clips them to the valid sequence space.
struct AckEvent {
  SeqNum ack = 0;
  std::vector<SackBlock> sacks{};
  std::optional<std::uint64_t> rtt_us{};
  TimePoint timestamp = 0;
  bool has_timestamp = false;
  // Karn's algorithm: the caller sets this to false when the ACK covers
  // retransmitted data and therefore cannot yield a trustworthy sample.
  bool rtt_valid = true;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

struct CongestionConfig {
  // Sender maximum segment size.  All windows are stored in bytes.
  std::uint32_t mss = 1460;

  // 0 selects the RFC 6928 initial window
  // min(10*MSS, max(2*MSS, 14600)).  Set explicitly for a textbook model
  // (for example 1*MSS).
  Bytes initial_cwnd = 0;

  // Default is effectively unlimited; slow start then lasts until a loss.
  Bytes initial_ssthresh = kInfiniteWindow;

  // 0 selects 2*MSS.  Fast recovery and loss responses never go below this.
  Bytes minimum_cwnd = 0;

  // First unacknowledged byte.  Non-zero for traces that start at an
  // arbitrary sequence number.
  SeqNum initial_ack = 0;

  // Number of duplicate-ACK indications required for fast retransmit.
  std::uint32_t duplicate_ack_threshold = 3;

  // false: one RFC 5681 increment (MSS*MSS/cwnd) per ACK.
  // true : appropriate byte counting, increment proportional to bytes ACKed.
  bool use_appropriate_byte_counting = false;

  // If disabled, SACK blocks are ignored and duplicate ACKs are counted the
  // legacy Reno way.
  bool sack_enabled = true;

  // false: one duplicate-ACK indication per arriving ACK event, the classic
  //        Reno rule.  true: newly SACKed segments also contribute to the
  //        duplicate-ACK count (RFC 6675 style loss detection).
  bool count_sacked_segments_as_dupacks = false;

  // Ignore RTT samples delivered while in fast recovery.
  bool ignore_rtt_during_recovery = false;

  std::uint64_t initial_rto_us = 1'000'000;
  std::uint64_t min_rto_us = 200'000;
  std::uint64_t max_rto_us = 60'000'000;
  std::uint64_t clock_granularity_us = 1'000;

  // Record the constructor state as change number 1.  Off by default because
  // it is not a *change*; useful for trace replay bookkeeping.
  bool record_initial_state = false;
};

using Config = CongestionConfig;

// ---------------------------------------------------------------------------
// Log records and snapshots
// ---------------------------------------------------------------------------

struct WindowChange {
  std::uint64_t sequence = 0;
  std::uint64_t index = 0;  // mirror of sequence
  TimePoint timestamp = 0;
  TimePoint time = 0;  // mirror of timestamp
  ChangeReason reason = ChangeReason::Initialization;
  ChangeReason cause = ChangeReason::Initialization;  // mirror of reason

  Bytes old_cwnd = 0;
  Bytes new_cwnd = 0;
  Bytes old_ssthresh = 0;
  Bytes new_ssthresh = 0;
  CongestionState old_state = CongestionState::SlowStart;
  CongestionState new_state = CongestionState::SlowStart;

  SeqNum ack = 0;
  std::uint64_t duplicate_acks = 0;
  Bytes bytes_in_flight = 0;
  Bytes pipe = 0;
  SeqNum recover = 0;

  constexpr Bytes cwnd_before() const noexcept { return old_cwnd; }
  constexpr Bytes cwnd_after() const noexcept { return new_cwnd; }
  constexpr Bytes ssthresh_before() const noexcept { return old_ssthresh; }
  constexpr Bytes ssthresh_after() const noexcept { return new_ssthresh; }
  constexpr CongestionState state_before() const noexcept { return old_state; }
  constexpr CongestionState state_after() const noexcept { return new_state; }
};

using WindowChangeRecord = WindowChange;
using ChangeRecord = WindowChange;

struct CongestionSnapshot {
  Bytes cwnd = 0;
  Bytes ssthresh = 0;
  CongestionState state = CongestionState::SlowStart;
  Bytes bytes_in_flight = 0;
  Bytes pipe = 0;
  SeqNum last_ack = 0;
  SeqNum highest_sent = 0;
  SeqNum recover = 0;
  std::uint32_t duplicate_acks = 0;
  std::uint64_t srtt_us = 0;
  std::uint64_t rttvar_us = 0;
  std::uint64_t rto_us = 0;
  bool have_rtt = false;
};

// ---------------------------------------------------------------------------
// Congestion controller
// ---------------------------------------------------------------------------

class CongestionController {
 public:
  using Config = CongestionConfig;
  using State = CongestionState;
  using Change = WindowChange;
  using Snapshot = CongestionSnapshot;
  using Sack = SackBlock;

  CongestionController() : CongestionController(CongestionConfig{}) {}

  explicit CongestionController(CongestionConfig cfg)
      : config_(cfg),
        mss_(cfg.mss == 0 ? 1u : cfg.mss),
        min_cwnd_(cfg.minimum_cwnd == 0
                      ? static_cast<Bytes>(2) * (cfg.mss == 0 ? 1u : cfg.mss)
                      : cfg.minimum_cwnd) {
    if (min_cwnd_ < mss_) min_cwnd_ = mss_;
    if (config_.duplicate_ack_threshold == 0) {
      config_.duplicate_ack_threshold = 1;
    }
    if (config_.min_rto_us == 0) config_.min_rto_us = 1;
    if (config_.max_rto_us < config_.min_rto_us) {
      config_.max_rto_us = config_.min_rto_us;
    }
    reset(true);
  }

  // Convenience constructor: MSS with the RFC 6928 initial window and an
  // unlimited initial slow-start threshold.
  explicit CongestionController(std::uint32_t mss)
      : CongestionController(make_config(mss)) {}

  // -----------------------------------------------------------------------
  // ACK input
  // -----------------------------------------------------------------------

  void on_ack(SeqNum ack) { process_ack(ack, {}, next_time()); }

  void on_ack(SeqNum ack, TimePoint when) { process_ack(ack, {}, when); }

  void on_ack(SeqNum ack, std::span<const SackBlock> sacks) {
    process_ack(ack, sacks, next_time());
  }

  void on_ack(SeqNum ack, std::span<const SackBlock> sacks, TimePoint when) {
    process_ack(ack, sacks, when);
  }

  // Alternate argument order used by some stacks.
  void on_ack(SeqNum ack, TimePoint when, std::span<const SackBlock> sacks) {
    process_ack(ack, sacks, when);
  }

  void on_ack(SeqNum ack, std::initializer_list<SackBlock> sacks) {
    process_ack(ack, std::span<const SackBlock>(sacks.begin(), sacks.size()),
                next_time());
  }

  void on_ack(SeqNum ack, std::initializer_list<SackBlock> sacks,
              TimePoint when) {
    process_ack(ack, std::span<const SackBlock>(sacks.begin(), sacks.size()),
                when);
  }

  void on_ack(const AckEvent& event) {
    const TimePoint when =
        event.has_timestamp ? event.timestamp : next_time();
    if (event.rtt_us.has_value() && event.rtt_valid) {
      note_rtt_sample(*event.rtt_us);
    }
    process_ack(event.ack, event.sacks, when);
  }

  // A SACK-only observation is an ACK whose cumulative point did not move.
  void on_sack(std::span<const SackBlock> sacks) {
    process_ack(last_ack_, sacks, next_time());
  }

  void on_sack(std::span<const SackBlock> sacks, TimePoint when) {
    process_ack(last_ack_, sacks, when);
  }

  void on_sack(SeqNum ack, std::span<const SackBlock> sacks) {
    process_ack(ack, sacks, next_time());
  }

  void on_sack(SeqNum ack, std::span<const SackBlock> sacks, TimePoint when) {
    process_ack(ack, sacks, when);
  }

  void on_sack(std::initializer_list<SackBlock> sacks) {
    process_ack(last_ack_,
                std::span<const SackBlock>(sacks.begin(), sacks.size()),
                next_time());
  }

  // Explicit duplicate ACK, primarily for Reno traces that carry no SACK
  // option.  A duplicate is counted once per call, never twice for one event.
  void on_duplicate_ack() { process_duplicate_ack({}, next_time()); }

  void on_duplicate_ack(SeqNum ack) {
    on_duplicate_ack(ack, next_time());
  }

  void on_duplicate_ack(SeqNum ack, TimePoint when) {
    if (ack > last_ack_) {
      process_ack(ack, {}, when);
    } else if (ack == last_ack_) {
      process_duplicate_ack({}, when);
    }
    // An ACK below snd_una is stale/reordered and must not affect the window.
  }

  // -----------------------------------------------------------------------
  // Loss, timeout and RTT input
  // -----------------------------------------------------------------------

  // An explicit fast-retransmit indication (for example a local loss
  // detector).  Unlike a timeout, this performs the halving and enters fast
  // recovery.  A repeated indication while already recovering is idempotent.
  void on_loss() { on_loss(next_time()); }

  void on_loss(TimePoint when) {
    if (state_ != CongestionState::FastRecovery) {
      enter_fast_recovery(ChangeReason::ExplicitLoss, when, 0);
    }
  }

  void on_timeout() { on_timeout(next_time()); }

  void on_timeout(TimePoint when) {
    const Bytes flight = effective_flight();
    const Bytes new_ssthresh = clamp_window(
        std::max<Bytes>(flight / 2, std::max<Bytes>(min_cwnd_, 2 * mss_)));

    // RFC 5681: a timeout collapses the window to one segment and restarts
    // slow start.  SACK information from before the timeout is discarded;
    // retaining it could understate the pipe and cause an oversend.
    sacked_.clear();
    sacked_bytes_ = 0;
    dup_acks_ = 0;
    recover_ = 0;

    // RFC 6298 exponential backoff.
    if (rto_us_ == 0) rto_us_ = config_.initial_rto_us;
    rto_us_ = clamp_rto(saturating_mul(rto_us_, 2));

    commit(mss_, new_ssthresh, CongestionState::SlowStart,
           ChangeReason::Timeout, last_ack_, when);
  }

  void on_rtt_sample(std::uint64_t rtt_us) { note_rtt_sample(rtt_us); }

  // valid=false models Karn ambiguity after a retransmission.
  void on_rtt_sample(std::uint64_t rtt_us, bool valid) {
    if (valid) note_rtt_sample(rtt_us);
  }

  void on_ack_with_rtt(SeqNum ack, std::uint64_t rtt_us) {
    note_rtt_sample(rtt_us);
    process_ack(ack, {}, next_time());
  }

  // -----------------------------------------------------------------------
  // Send accounting
  // -----------------------------------------------------------------------

  bool can_send(Bytes bytes = 1) const noexcept {
    if (bytes == 0) return true;
    const Bytes used = pipe();
    return bytes <= cwnd_ && used <= cwnd_ - bytes;
  }

  Bytes available_window() const noexcept {
    const Bytes used = pipe();
    return cwnd_ > used ? cwnd_ - used : 0;
  }

  Bytes send_window() const noexcept { return available_window(); }
  Bytes writable_bytes() const noexcept { return available_window(); }

  // Gated send: records the bytes only when the congestion window permits.
  bool try_send(Bytes bytes) noexcept {
    if (!can_send(bytes)) return false;
    record_send(bytes, std::nullopt);
    return true;
  }

  bool send(Bytes bytes) noexcept { return try_send(bytes); }

  // Observed send: the caller already handed these bytes to the network.
  // The bytes are always accounted so that later ACK processing remains
  // consistent; the return value says whether the send respected cwnd.
  bool on_send(Bytes bytes) noexcept { return record_send(bytes, std::nullopt); }

  bool note_send(Bytes bytes) noexcept { return on_send(bytes); }

  // Sequence-aware variant.  seq is the first byte and bytes the length.
  // Call only for new data; retransmissions are not new in-flight data.
  bool on_packet_sent(SeqNum seq, Bytes bytes) noexcept {
    return record_send(bytes, seq);
  }

  // -----------------------------------------------------------------------
  // Camel-case facade
  // -----------------------------------------------------------------------

  template <class... Args>
  void onAck(Args&&... args) {
    on_ack(std::forward<Args>(args)...);
  }
  template <class... Args>
  void onSack(Args&&... args) {
    on_sack(std::forward<Args>(args)...);
  }
  template <class... Args>
  void onDuplicateAck(Args&&... args) {
    on_duplicate_ack(std::forward<Args>(args)...);
  }
  template <class... Args>
  void onDupAck(Args&&... args) {
    on_duplicate_ack(std::forward<Args>(args)...);
  }
  void onTimeout() { on_timeout(); }
  void onTimeout(TimePoint when) { on_timeout(when); }
  void onLoss() { on_loss(); }
  void onLoss(TimePoint when) { on_loss(when); }
  void onRttSample(std::uint64_t rtt_us) { on_rtt_sample(rtt_us); }
  void onRttSample(std::uint64_t rtt_us, bool valid) {
    on_rtt_sample(rtt_us, valid);
  }
  bool onSend(Bytes bytes) noexcept { return on_send(bytes); }
  bool canSend(Bytes bytes = 1) const noexcept { return can_send(bytes); }
  bool trySend(Bytes bytes) noexcept { return try_send(bytes); }

  // -----------------------------------------------------------------------
  // Observation
  // -----------------------------------------------------------------------

  Bytes cwnd() const noexcept { return cwnd_; }
  Bytes congestion_window() const noexcept { return cwnd_; }
  Bytes congestionWindow() const noexcept { return cwnd_; }
  Bytes cwnd_bytes() const noexcept { return cwnd_; }
  std::uint32_t cwnd_packets() const noexcept {
    return static_cast<std::uint32_t>(
        std::min<Bytes>(cwnd_ / mss_, std::numeric_limits<std::uint32_t>::max()));
  }
  std::uint32_t cwnd_segments() const noexcept { return cwnd_packets(); }

  Bytes ssthresh() const noexcept { return ssthresh_; }
  Bytes slow_start_threshold() const noexcept { return ssthresh_; }
  Bytes slowStartThreshold() const noexcept { return ssthresh_; }

  CongestionState state() const noexcept { return state_; }
  CongestionState congestion_state() const noexcept { return state_; }
  std::string_view state_name() const noexcept { return to_string(state_); }

  bool in_slow_start() const noexcept {
    return state_ == CongestionState::SlowStart;
  }
  bool in_congestion_avoidance() const noexcept {
    return state_ == CongestionState::CongestionAvoidance;
  }
  bool in_fast_recovery() const noexcept {
    return state_ == CongestionState::FastRecovery;
  }
  bool inSlowStart() const noexcept { return in_slow_start(); }
  bool inCongestionAvoidance() const noexcept {
    return in_congestion_avoidance();
  }
  bool inFastRecovery() const noexcept { return in_fast_recovery(); }

  std::uint32_t duplicate_acks() const noexcept { return dup_acks_; }
  std::uint32_t duplicate_ack_count() const noexcept { return dup_acks_; }
  std::uint32_t duplicateAckCount() const noexcept { return dup_acks_; }
  Bytes bytes_in_flight() const noexcept { return bytes_in_flight_; }
  Bytes flight_size() const noexcept { return bytes_in_flight_; }
  Bytes bytesInFlight() const noexcept { return bytes_in_flight_; }
  Bytes availableWindow() const noexcept { return available_window(); }

  Bytes pipe() const noexcept {
    return bytes_in_flight_ > sacked_bytes_
               ? bytes_in_flight_ - sacked_bytes_
               : 0;
  }

  SeqNum last_ack() const noexcept { return last_ack_; }
  SeqNum snd_una() const noexcept { return last_ack_; }
  SeqNum highest_sent() const noexcept { return highest_sent_; }
  SeqNum recover() const noexcept { return recover_; }
  SeqNum recover_point() const noexcept { return recover_; }
  std::uint32_t mss() const noexcept { return mss_; }
  const CongestionConfig& config() const noexcept { return config_; }

  Bytes sacked_bytes() const noexcept { return sacked_bytes_; }
  const std::vector<SackBlock>& sack_scoreboard() const noexcept {
    return sacked_;
  }

  std::uint64_t srtt_us() const noexcept { return srtt_us_; }
  std::uint64_t smoothed_rtt_us() const noexcept { return srtt_us_; }
  std::uint64_t rttvar_us() const noexcept { return rttvar_us_; }
  std::uint64_t rtt_variance_us() const noexcept { return rttvar_us_; }
  std::uint64_t rto_us() const noexcept { return rto_us_; }
  bool have_rtt_sample() const noexcept { return have_rtt_; }

  CongestionSnapshot snapshot() const noexcept {
    return CongestionSnapshot{
        cwnd_,
        ssthresh_,
        state_,
        bytes_in_flight_,
        pipe(),
        last_ack_,
        highest_sent_,
        recover_,
        dup_acks_,
        srtt_us_,
        rttvar_us_,
        rto_us_,
        have_rtt_,
    };
  }

  const std::vector<WindowChange>& history() const noexcept {
    return history_;
  }
  const std::vector<WindowChange>& changes() const noexcept {
    return history_;
  }
  const std::vector<WindowChange>& window_changes() const noexcept {
    return history_;
  }
  const std::vector<WindowChange>& change_log() const noexcept {
    return history_;
  }

  const WindowChange* last_change() const noexcept {
    return history_.empty() ? nullptr : &history_.back();
  }

  void clear_history() noexcept {
    history_.clear();
    change_sequence_ = 0;
  }

  void reset(bool clear_change_log = true) noexcept {
    cwnd_ = config_.initial_cwnd == 0
                ? default_initial_window(mss_)
                : config_.initial_cwnd;
    if (cwnd_ < mss_) cwnd_ = mss_;
    cwnd_ = clamp_window(cwnd_);
    ssthresh_ = clamp_window(config_.initial_ssthresh);
    state_ = cwnd_ < ssthresh_ ? CongestionState::SlowStart
                               : CongestionState::CongestionAvoidance;

    last_ack_ = config_.initial_ack;
    highest_sent_ = config_.initial_ack;
    recover_ = 0;
    bytes_in_flight_ = 0;
    sacked_.clear();
    sacked_bytes_ = 0;
    dup_acks_ = 0;
    sends_tracked_ = false;

    srtt_us_ = 0;
    rttvar_us_ = 0;
    rto_us_ = config_.initial_rto_us;
    have_rtt_ = false;
    logical_time_ = 0;

    if (clear_change_log) {
      history_.clear();
      change_sequence_ = 0;
    }

    if (config_.record_initial_state) {
      WindowChange c;
      c.sequence = ++change_sequence_;
      c.index = c.sequence;
      c.timestamp = 0;
      c.time = 0;
      c.reason = ChangeReason::Initialization;
      c.cause = ChangeReason::Initialization;
      c.old_cwnd = cwnd_;
      c.new_cwnd = cwnd_;
      c.old_ssthresh = ssthresh_;
      c.new_ssthresh = ssthresh_;
      c.old_state = state_;
      c.new_state = state_;
      c.ack = last_ack_;
      c.duplicate_acks = 0;
      c.bytes_in_flight = 0;
      history_.push_back(c);
    }
  }

 private:
  // -----------------------------------------------------------------------
  // Small deterministic helpers
  // -----------------------------------------------------------------------

  static constexpr CongestionConfig make_config(std::uint32_t mss) noexcept {
    CongestionConfig cfg;
    cfg.mss = mss;
    return cfg;
  }

  static constexpr Bytes saturating_add(Bytes a, Bytes b) noexcept {
    return a > kMaxWindow - std::min<Bytes>(b, kMaxWindow)
               ? kMaxWindow
               : a + b;
  }

  static constexpr Bytes saturating_mul(Bytes a, Bytes b) noexcept {
    if (a == 0 || b == 0) return 0;
    if (a > kMaxWindow / b) return kMaxWindow;
    return a * b;
  }

  static constexpr Bytes clamp_window(Bytes value) noexcept {
    return value > kMaxWindow ? kMaxWindow : value;
  }

  static constexpr Bytes default_initial_window(std::uint32_t mss) noexcept {
    const Bytes m = mss == 0 ? 1 : mss;
    // RFC 6928.
    return std::min<Bytes>(10 * m, std::max<Bytes>(2 * m, 14600));
  }

  std::uint64_t clamp_rto(std::uint64_t value) const noexcept {
    if (value < config_.min_rto_us) return config_.min_rto_us;
    if (value > config_.max_rto_us) return config_.max_rto_us;
    return value;
  }

  TimePoint next_time() noexcept { return logical_time_++; }

  void observe_time(TimePoint when) noexcept {
    if (when >= logical_time_) logical_time_ = when + 1;
  }

  // -----------------------------------------------------------------------
  // State transition record
  // -----------------------------------------------------------------------

  void commit(Bytes new_cwnd, Bytes new_ssthresh, CongestionState new_state,
              ChangeReason reason, SeqNum ack, TimePoint when) {
    new_cwnd = clamp_window(new_cwnd);
    new_ssthresh = clamp_window(new_ssthresh);
    observe_time(when);
    if (new_cwnd == cwnd_ && new_ssthresh == ssthresh_ &&
        new_state == state_) {
      return;
    }

    WindowChange c;
    c.sequence = ++change_sequence_;
    c.index = c.sequence;
    c.timestamp = when;
    c.time = when;
    c.reason = reason;
    c.cause = reason;
    c.old_cwnd = cwnd_;
    c.new_cwnd = new_cwnd;
    c.old_ssthresh = ssthresh_;
    c.new_ssthresh = new_ssthresh;
    c.old_state = state_;
    c.new_state = new_state;
    c.ack = ack;
    c.duplicate_acks = dup_acks_;
    c.bytes_in_flight = bytes_in_flight_;
    c.pipe = pipe();
    c.recover = recover_;
    history_.push_back(c);

    cwnd_ = new_cwnd;
    ssthresh_ = new_ssthresh;
    state_ = new_state;
  }

  // -----------------------------------------------------------------------
  // SACK scoreboard
  // -----------------------------------------------------------------------

  void prune_scoreboard(SeqNum ack) {
    Bytes new_sacked = 0;
    std::size_t out = 0;
    for (std::size_t i = 0; i < sacked_.size(); ++i) {
      SackBlock block = sacked_[i];
      if (block.right <= ack) continue;
      if (block.left < ack) block.left = ack;
      if (block.empty()) continue;
      sacked_[out++] = block;
      new_sacked = saturating_add(new_sacked, block.length());
    }
    sacked_.resize(out);
    sacked_bytes_ = new_sacked;
  }

  // Returns the number of *newly* SACKed bytes above snd_una.  Repeating an
  // identical SACK option therefore yields zero and changes nothing.
  Bytes update_scoreboard(std::span<const SackBlock> blocks, SeqNum ack) {
    if (!config_.sack_enabled || blocks.empty()) return 0;
    const Bytes before = sacked_bytes_;

    std::vector<SackBlock> merged;
    merged.reserve(sacked_.size() + blocks.size());
    merged.insert(merged.end(), sacked_.begin(), sacked_.end());
    for (const SackBlock& raw : blocks) {
      SeqNum left = std::max(raw.left, ack);
      SeqNum right = raw.right;
      if (sends_tracked_ && right > highest_sent_) right = highest_sent_;
      if (right <= left) continue;
      merged.push_back(SackBlock{left, right});
    }

    std::sort(merged.begin(), merged.end(),
              [](const SackBlock& a, const SackBlock& b) {
                return a.left < b.left ||
                       (a.left == b.left && a.right < b.right);
              });

    sacked_.clear();
    for (const SackBlock& block : merged) {
      if (block.empty()) continue;
      if (sacked_.empty() || block.left > sacked_.back().right) {
        sacked_.push_back(block);
      } else if (block.right > sacked_.back().right) {
        sacked_.back().right = block.right;
      }
    }

    sacked_bytes_ = 0;
    for (const SackBlock& block : sacked_) {
      sacked_bytes_ = saturating_add(sacked_bytes_, block.length());
    }
    return sacked_bytes_ > before ? sacked_bytes_ - before : 0;
  }

  // -----------------------------------------------------------------------
  // Loss response
  // -----------------------------------------------------------------------

  Bytes effective_flight() const noexcept {
    if (bytes_in_flight_ > 0) {
      const Bytes p = pipe();
      return p > 0 ? p : bytes_in_flight_;
    }
    // A caller may drive the controller purely from ACK observations without
    // reporting sends.  In that case the current window is the only available
    // upper bound on FlightSize.
    return cwnd_ > 0 ? cwnd_ : mss_;
  }

  bool enter_fast_recovery(ChangeReason reason, TimePoint when,
                           Bytes flight_override) {
    if (state_ == CongestionState::FastRecovery) return false;
    const Bytes flight =
        flight_override > 0 ? flight_override : effective_flight();
    const Bytes new_ssthresh = clamp_window(
        std::max<Bytes>(flight / 2, std::max<Bytes>(min_cwnd_, 2 * mss_)));

    recover_ = std::max<SeqNum>(
        highest_sent_, saturating_add(last_ack_, flight));
    if (recover_ <= last_ack_) {
      recover_ = saturating_add(last_ack_, mss_);
    }

    const Bytes new_cwnd =
        saturating_add(new_ssthresh, saturating_mul(3, mss_));
    commit(new_cwnd, new_ssthresh, CongestionState::FastRecovery, reason,
           last_ack_, when);
    return true;
  }

  // -----------------------------------------------------------------------
  // ACK processing
  // -----------------------------------------------------------------------

  void process_ack(SeqNum ack, std::span<const SackBlock> sacks,
                   TimePoint when) {
    observe_time(when);

    // With send accounting enabled, an ACK beyond the highest byte ever sent
    // is not a valid cumulative acknowledgement and must not grow the window.
    if (sends_tracked_ && ack > highest_sent_) return;

    if (ack < last_ack_) {
      // Reordered/stale ACK.  It may carry SACK blocks for data that is still
      // outstanding, but it must not move cwnd, ssthresh or the dup-ACK count.
      return;
    }

    if (ack == last_ack_) {
      process_duplicate_ack(sacks, when);
      return;
    }

    const Bytes newly_acked = ack - last_ack_;
    last_ack_ = ack;
    bytes_in_flight_ =
        bytes_in_flight_ > newly_acked ? bytes_in_flight_ - newly_acked : 0;
    prune_scoreboard(ack);
    if (!sacks.empty()) {
      // SACK blocks normally travel with an advancing cumulative ACK; keep
      // the scoreboard current so pipe cannot be overestimated.
      update_scoreboard(sacks, ack);
    }
    dup_acks_ = 0;

    if (state_ == CongestionState::FastRecovery) {
      if (ack >= recover_) {
        // NewReno full ACK: leave recovery at the reduced threshold.  The
        // next ACK performs the first congestion-avoidance increment, so
        // recovery does not leave a half-open slow-start episode behind.
        recover_ = last_ack_;
        commit(ssthresh_, ssthresh_, CongestionState::CongestionAvoidance,
               ChangeReason::RecoveryExit, ack, when);
      } else {
        // NewReno partial ACK: deflate by the newly acknowledged data and
        // add one segment, keeping the pipe estimate honest.
        Bytes next = cwnd_ > newly_acked ? cwnd_ - newly_acked : 0;
        next = saturating_add(next, mss_);
        if (next < mss_) next = mss_;
        commit(next, ssthresh_, CongestionState::FastRecovery,
               ChangeReason::PartialAcknowledgment, ack, when);
      }
      return;
    }

    Bytes next_cwnd = cwnd_;
    CongestionState next_state = state_;

    if (cwnd_ < ssthresh_) {
      // RFC 5681 slow start: at most one SMSS per ACK.  Appropriate byte
      // counting (RFC 3465) permits up to two SMSS for a large ACK.
      const Bytes cap = config_.use_appropriate_byte_counting
                            ? 2 * static_cast<Bytes>(mss_)
                            : static_cast<Bytes>(mss_);
      next_cwnd = saturating_add(cwnd_, std::min<Bytes>(newly_acked, cap));
      next_state = next_cwnd < ssthresh_ ? CongestionState::SlowStart
                                         : CongestionState::CongestionAvoidance;
    } else {
      next_state = CongestionState::CongestionAvoidance;
      const Bytes counted =
          config_.use_appropriate_byte_counting
              ? std::min<Bytes>(newly_acked, 2 * static_cast<Bytes>(mss_))
              : static_cast<Bytes>(mss_);
      const Bytes increment =
          std::max<Bytes>(1, saturating_mul(mss_, counted) / cwnd_);
      next_cwnd = saturating_add(cwnd_, increment);
    }

    commit(next_cwnd, ssthresh_, next_state, ChangeReason::Acknowledgment,
           ack, when);
  }

  void process_duplicate_ack(std::span<const SackBlock> sacks,
                             TimePoint when) {
    observe_time(when);

    const Bytes old_sacked = sacked_bytes_;
    const Bytes new_sacked = update_scoreboard(sacks, last_ack_);
    const bool has_new_information = new_sacked > old_sacked;

    std::uint32_t increment = 1;
    if (has_new_information && config_.count_sacked_segments_as_dupacks) {
      const Bytes segments =
          (new_sacked + mss_ - 1) / mss_;  // cover a partial segment
      const std::uint64_t capped =
          std::min<Bytes>(segments, std::numeric_limits<std::uint32_t>::max());
      increment = std::max<std::uint32_t>(1, static_cast<std::uint32_t>(capped));
    }

    if (state_ != CongestionState::FastRecovery) {
      const std::uint64_t total =
          std::min<std::uint64_t>(
              static_cast<std::uint64_t>(dup_acks_) + increment,
              std::numeric_limits<std::uint32_t>::max());
      dup_acks_ = static_cast<std::uint32_t>(total);
      if (dup_acks_ >= config_.duplicate_ack_threshold) {
        enter_fast_recovery(has_new_information
                                ? ChangeReason::SelectiveAcknowledgment
                                : ChangeReason::FastRetransmit,
                            when, 0);
      }
      return;
    }

    // Additional duplicate ACKs inflate the window by one segment.  Each
    // event is counted once, irrespective of how many SACK blocks it carries,
    // which keeps the inflation bounded during ACK reordering.
    if (dup_acks_ < std::numeric_limits<std::uint32_t>::max()) ++dup_acks_;
    commit(saturating_add(cwnd_, mss_), ssthresh_,
           CongestionState::FastRecovery, ChangeReason::DuplicateAcknowledgment,
           last_ack_, when);
  }

  // -----------------------------------------------------------------------
  // RTT estimation (RFC 6298)
  // -----------------------------------------------------------------------

  void note_rtt_sample(std::uint64_t rtt_us) {
    if (rtt_us == 0) rtt_us = 1;
    if (config_.ignore_rtt_during_recovery &&
        state_ == CongestionState::FastRecovery) {
      return;
    }

    if (!have_rtt_) {
      srtt_us_ = rtt_us;
      rttvar_us_ = rtt_us / 2;
      have_rtt_ = true;
    } else {
      const std::uint64_t diff =
          rtt_us > srtt_us_ ? rtt_us - srtt_us_ : srtt_us_ - rtt_us;
      // rttvar = 3/4*rttvar + 1/4*|srtt-rtt|
      // srtt   = 7/8*srtt + 1/8*rtt
      rttvar_us_ = (3 * rttvar_us_ + diff) / 4;
      srtt_us_ = (7 * srtt_us_ + rtt_us) / 8;
    }

    const std::uint64_t granularity =
        std::max<std::uint64_t>(config_.clock_granularity_us, 1);
    const std::uint64_t variation =
        std::max<std::uint64_t>(granularity, saturating_mul(4, rttvar_us_));
    rto_us_ = clamp_rto(saturating_add(srtt_us_, variation));
  }

  bool record_send(Bytes bytes, std::optional<SeqNum> seq) noexcept {
    if (bytes == 0) return true;
    const bool allowed = can_send(bytes);
    bytes_in_flight_ = saturating_add(bytes_in_flight_, bytes);
    SeqNum end = seq.has_value()
                     ? saturating_add(*seq, bytes)
                     : saturating_add(last_ack_, bytes_in_flight_);
    if (end > highest_sent_) highest_sent_ = end;
    sends_tracked_ = true;
    return allowed;
  }

  // -----------------------------------------------------------------------
  // Fields
  // -----------------------------------------------------------------------

  CongestionConfig config_{};
  std::uint32_t mss_ = 1460;
  Bytes min_cwnd_ = 2920;

  Bytes cwnd_ = 0;
  Bytes ssthresh_ = kInfiniteWindow;
  CongestionState state_ = CongestionState::SlowStart;

  SeqNum last_ack_ = 0;
  SeqNum highest_sent_ = 0;
  SeqNum recover_ = 0;

  Bytes bytes_in_flight_ = 0;
  std::vector<SackBlock> sacked_{};
  Bytes sacked_bytes_ = 0;
  std::uint32_t dup_acks_ = 0;
  bool sends_tracked_ = false;

  std::uint64_t srtt_us_ = 0;
  std::uint64_t rttvar_us_ = 0;
  std::uint64_t rto_us_ = 0;
  bool have_rtt_ = false;

  TimePoint logical_time_ = 0;
  std::vector<WindowChange> history_{};
  std::uint64_t change_sequence_ = 0;
};

using CongestionControl = CongestionController;
using TcpCongestionController = CongestionController;
using RenoController = CongestionController;
using NewRenoController = CongestionController;
using Reno = CongestionController;
using NewReno = CongestionController;
using CwndController = CongestionController;
using CcController = CongestionController;

// Camel-case facade for stacks that keep their existing spelling.
using CongestionStateMachine = CongestionController;

}  // namespace dlks_formal
