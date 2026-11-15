#pragma once

#include <cstdint>
#include <string>
#include <variant>
#include <vector>

namespace dataeng {

using CheckpointId = std::uint64_t;
using ChannelId = std::uint32_t;
using SeqNo = std::uint64_t;

// Upstream data buffer flowing through one input channel.
struct Buffer {
  ChannelId channel = 0;
  SeqNo seq = 0;
  std::string payload;
};

// Checkpoint barrier injected by the source into one input channel.
struct Barrier {
  ChannelId channel = 0;
  CheckpointId checkpoint = 0;
};

using InputEvent = std::variant<Buffer, Barrier>;

enum class AlignmentMode { Aligned, Unaligned };

// In-flight buffers of one channel that overtook the barrier and were
// captured into the checkpoint (unaligned) or observed at switch time.
struct ChannelInflight {
  ChannelId channel = 0;
  std::vector<Buffer> buffers; // ordered by arrival
};

// Durable evidence emitted when the coordinator switches alignment mode.
struct ModeSwitchEvidence {
  CheckpointId checkpoint = 0;
  std::uint64_t logical_time_ms = 0;
  AlignmentMode from = AlignmentMode::Aligned;
  AlignmentMode to = AlignmentMode::Unaligned;
  std::vector<ChannelInflight> inflight_at_switch; // per-channel snapshot
  std::string reason;
};

// Completed checkpoint state; everything needed for exactly-once recovery.
struct CheckpointSnapshot {
  CheckpointId checkpoint = 0;
  AlignmentMode mode = AlignmentMode::Aligned;
  // Buffers that overtook the barrier. Empty for aligned checkpoints.
  // On recovery these are replayed into the operator inputs before the
  // stream resumes, so nothing is lost and nothing is applied twice.
  std::vector<ChannelInflight> channel_states;
};

// Actions the coordinator asks the embedding operator to perform.
struct ForwardBuffer {
  Buffer buffer;
};
struct EmitBarrier {
  CheckpointId checkpoint;
};
struct CompleteCheckpoint {
  CheckpointSnapshot snapshot;
};
struct AbortCheckpoint {
  CheckpointId checkpoint;
  CheckpointId superseded_by;
};
using Action = std::variant<ForwardBuffer, EmitBarrier, CompleteCheckpoint,
                            AbortCheckpoint>;

// Embeddable checkpoint barrier coordinator for one multi-input operator.
//
// Semantics:
//  - Aligned mode: a channel is blocked once its barrier arrives; buffered
//    records are held until every channel reported the barrier.
//  - If alignment exceeds the budget, the coordinator switches to unaligned
//    exactly once, records per-channel in-flight buffers as evidence, and
//    lets buffers overtake the barrier while capturing them into the
//    checkpoint's channel state.
//  - A repeated barrier for an already-reported (channel, checkpoint) pair
//    is idempotent and produces no action.
//  - A barrier of a newer checkpoint aborts any pending older checkpoint;
//    stale barriers of old epochs never block a newer generation.
//  - restore_plan() yields the buffers to replay per channel on recovery.
class BarrierCoordinator {
public:
  BarrierCoordinator(std::uint32_t num_channels,
                     std::uint64_t alignment_budget_ms);

  // Feed one input event observed at logical time `now_ms`.
  std::vector<Action> on_event(const InputEvent& event,
                               std::uint64_t now_ms);

  // Timer hook: triggers the aligned -> unaligned switch even when no new
  // events arrive. Safe to call at any time.
  std::vector<Action> poll(std::uint64_t now_ms);

  AlignmentMode mode() const;
  bool alignment_in_progress() const;
  CheckpointId last_completed() const;

  const std::vector<ModeSwitchEvidence>& evidence_log() const;

  // Buffers to re-inject per channel (in original order) when recovering
  // from `snapshot`, before resuming the stream after the barrier.
  static std::vector<ChannelInflight> restore_plan(
      const CheckpointSnapshot& snapshot);

  // Serializes one evidence record for durable audit storage.
  static std::string evidence_to_json(const ModeSwitchEvidence& evidence);

private:
  struct PendingCheckpoint {
    CheckpointId id = 0;
    AlignmentMode mode = AlignmentMode::Aligned;
    std::uint64_t start_ms = 0;
    std::vector<bool> barrier_received;
    std::uint32_t received_count = 0;
    // Aligned: records held back on blocked channels.
    std::vector<std::vector<Buffer>> held;
    // Unaligned: records that overtook the barrier, captured as state.
    std::vector<std::vector<Buffer>> inflight;
  };

  std::vector<Action> switch_to_unaligned(std::uint64_t now_ms);
  std::vector<Action> complete_pending();
  void start_pending(CheckpointId id, std::uint64_t now_ms);

  std::uint32_t num_channels_;
  std::uint64_t alignment_budget_ms_;
  CheckpointId last_completed_ = 0;
  bool has_pending_ = false;
  PendingCheckpoint pending_;
  std::vector<ModeSwitchEvidence> evidence_log_;
};

} // namespace dataeng
