#include "dataeng.hpp"

#include <sstream>
#include <utility>

namespace dataeng {

BarrierCoordinator::BarrierCoordinator(std::uint32_t num_channels,
                                       std::uint64_t alignment_budget_ms)
    : num_channels_(num_channels), alignment_budget_ms_(alignment_budget_ms) {}

AlignmentMode BarrierCoordinator::mode() const {
  return has_pending_ ? pending_.mode : AlignmentMode::Aligned;
}

bool BarrierCoordinator::alignment_in_progress() const { return has_pending_; }

CheckpointId BarrierCoordinator::last_completed() const {
  return last_completed_;
}

const std::vector<ModeSwitchEvidence>& BarrierCoordinator::evidence_log()
    const {
  return evidence_log_;
}

void BarrierCoordinator::start_pending(CheckpointId id,
                                       std::uint64_t now_ms) {
  pending_ = PendingCheckpoint{};
  pending_.id = id;
  pending_.mode = AlignmentMode::Aligned;
  pending_.start_ms = now_ms;
  pending_.barrier_received.assign(num_channels_, false);
  pending_.held.resize(num_channels_);
  pending_.inflight.resize(num_channels_);
  has_pending_ = true;
}

std::vector<Action> BarrierCoordinator::switch_to_unaligned(
    std::uint64_t now_ms) {
  std::vector<Action> actions;

  ModeSwitchEvidence evidence;
  evidence.checkpoint = pending_.id;
  evidence.logical_time_ms = now_ms;
  evidence.from = AlignmentMode::Aligned;
  evidence.to = AlignmentMode::Unaligned;
  evidence.reason = "alignment_budget_exceeded";

  // Record the exact in-flight buffers of every channel at the switch
  // instant, then release them so they may overtake the barrier. Each
  // released buffer is also captured into the checkpoint channel state.
  for (ChannelId ch = 0; ch < num_channels_; ++ch) {
    if (pending_.held[ch].empty()) {
      continue;
    }
    ChannelInflight inflight;
    inflight.channel = ch;
    inflight.buffers = pending_.held[ch];
    evidence.inflight_at_switch.push_back(inflight);

    for (const Buffer& buf : pending_.held[ch]) {
      pending_.inflight[ch].push_back(buf);
      actions.push_back(ForwardBuffer{buf});
    }
    pending_.held[ch].clear();
  }

  pending_.mode = AlignmentMode::Unaligned;
  evidence_log_.push_back(std::move(evidence));
  return actions;
}

std::vector<Action> BarrierCoordinator::complete_pending() {
  std::vector<Action> actions;
  actions.push_back(EmitBarrier{pending_.id});

  CheckpointSnapshot snapshot;
  snapshot.checkpoint = pending_.id;
  snapshot.mode = pending_.mode;

  if (pending_.mode == AlignmentMode::Aligned) {
    // Release records held on blocked channels; they belong to the next
    // epoch and follow the emitted barrier downstream.
    for (ChannelId ch = 0; ch < num_channels_; ++ch) {
      for (const Buffer& buf : pending_.held[ch]) {
        actions.push_back(ForwardBuffer{buf});
      }
    }
  } else {
    for (ChannelId ch = 0; ch < num_channels_; ++ch) {
      if (!pending_.inflight[ch].empty()) {
        snapshot.channel_states.push_back(
            ChannelInflight{ch, pending_.inflight[ch]});
      }
    }
  }

  actions.push_back(CompleteCheckpoint{std::move(snapshot)});
  last_completed_ = pending_.id;
  has_pending_ = false;
  return actions;
}

std::vector<Action> BarrierCoordinator::poll(std::uint64_t now_ms) {
  if (has_pending_ && pending_.mode == AlignmentMode::Aligned &&
      now_ms - pending_.start_ms > alignment_budget_ms_) {
    return switch_to_unaligned(now_ms);
  }
  return {};
}

std::vector<Action> BarrierCoordinator::on_event(const InputEvent& event,
                                                 std::uint64_t now_ms) {
  std::vector<Action> actions = poll(now_ms);

  if (const auto* buffer = std::get_if<Buffer>(&event)) {
    if (has_pending_ && pending_.barrier_received[buffer->channel]) {
      if (pending_.mode == AlignmentMode::Aligned) {
        pending_.held[buffer->channel].push_back(*buffer);
      } else {
        pending_.inflight[buffer->channel].push_back(*buffer);
        actions.push_back(ForwardBuffer{*buffer});
      }
    } else {
      actions.push_back(ForwardBuffer{*buffer});
    }
    return actions;
  }

  const auto& barrier = std::get<Barrier>(event);

  // Stale barrier of an old epoch: never blocks the current generation.
  if (barrier.checkpoint <= last_completed_ ||
      (has_pending_ && barrier.checkpoint < pending_.id)) {
    return actions;
  }

  // Newer generation supersedes a pending older checkpoint.
  if (has_pending_ && barrier.checkpoint > pending_.id) {
    actions.push_back(
        AbortCheckpoint{pending_.id, barrier.checkpoint});
    // The old checkpoint is aborted; its held records are pure data again.
    for (ChannelId ch = 0; ch < num_channels_; ++ch) {
      for (const Buffer& buf : pending_.held[ch]) {
        actions.push_back(ForwardBuffer{buf});
      }
    }
    start_pending(barrier.checkpoint, now_ms);
  } else if (!has_pending_) {
    start_pending(barrier.checkpoint, now_ms);
  }

  // Idempotency: a repeated barrier for the same channel and checkpoint
  // is acknowledged but drives no state transition.
  if (pending_.barrier_received[barrier.channel]) {
    return actions;
  }

  pending_.barrier_received[barrier.channel] = true;
  ++pending_.received_count;

  if (pending_.received_count == num_channels_) {
    std::vector<Action> done = complete_pending();
    actions.insert(actions.end(), done.begin(), done.end());
  }
  return actions;
}

std::vector<ChannelInflight> BarrierCoordinator::restore_plan(
    const CheckpointSnapshot& snapshot) {
  return snapshot.channel_states;
}

std::string BarrierCoordinator::evidence_to_json(
    const ModeSwitchEvidence& evidence) {
  std::ostringstream out;
  out << "{\"checkpoint\":" << evidence.checkpoint
      << ",\"logical_time_ms\":" << evidence.logical_time_ms
      << ",\"from\":\""
      << (evidence.from == AlignmentMode::Aligned ? "aligned" : "unaligned")
      << "\",\"to\":\""
      << (evidence.to == AlignmentMode::Aligned ? "aligned" : "unaligned")
      << "\",\"reason\":\"" << evidence.reason << "\",\"inflight\":[";
  bool first_channel = true;
  for (const ChannelInflight& inflight : evidence.inflight_at_switch) {
    if (!first_channel) {
      out << ',';
    }
    first_channel = false;
    out << "{\"channel\":" << inflight.channel << ",\"seqs\":[";
    bool first_seq = true;
    for (const Buffer& buf : inflight.buffers) {
      if (!first_seq) {
        out << ',';
      }
      first_seq = false;
      out << buf.seq;
    }
    out << "]}";
  }
  out << "]}";
  return out.str();
}

} // namespace dataeng
