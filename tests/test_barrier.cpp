#include "dataeng.hpp"

#include <cstdlib>
#include <iostream>
#include <set>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      ++g_failures;                                                          \
      std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": " #cond      \
                << std::endl;                                                \
    }                                                                        \
  } while (0)

using namespace dataeng;

template <typename T>
std::vector<const T*> actions_of(const std::vector<Action>& actions) {
  std::vector<const T*> out;
  for (const auto& action : actions) {
    if (const auto* typed = std::get_if<T>(&action)) {
      out.push_back(typed);
    }
  }
  return out;
}

Buffer buf(ChannelId channel, SeqNo seq) {
  return Buffer{channel, seq, "payload-" + std::to_string(seq)};
}

// 1. Aligned checkpoint completes inside the budget: blocked channel data
//    is held, then released after the barrier is emitted downstream.
void test_aligned_happy_path() {
  BarrierCoordinator coord(2, 1000);

  auto a1 = coord.on_event(Barrier{0, 1}, 0);
  CHECK(a1.empty());
  CHECK(coord.alignment_in_progress());

  auto a2 = coord.on_event(buf(0, 10), 10);
  CHECK(a2.empty()); // held back on blocked channel 0

  auto a3 = coord.on_event(buf(1, 20), 20);
  CHECK(actions_of<ForwardBuffer>(a3).size() == 1); // channel 1 flows

  auto a4 = coord.on_event(Barrier{1, 1}, 30);
  CHECK(actions_of<EmitBarrier>(a4).size() == 1);
  auto completed = actions_of<CompleteCheckpoint>(a4);
  CHECK(completed.size() == 1);
  CHECK(completed[0]->snapshot.mode == AlignmentMode::Aligned);
  CHECK(completed[0]->snapshot.channel_states.empty());
  auto forwarded = actions_of<ForwardBuffer>(a4);
  CHECK(forwarded.size() == 1); // held buffer released after the barrier
  CHECK(forwarded[0]->buffer.seq == 10);
  CHECK(coord.last_completed() == 1);
  CHECK(coord.evidence_log().empty());
}

// 2. Alignment overruns the budget: the coordinator switches to unaligned,
//    records per-channel in-flight buffers as evidence, and captures all
//    overtaking buffers into the checkpoint state.
void test_unaligned_switch_on_budget_exceeded() {
  BarrierCoordinator coord(2, 100);

  coord.on_event(Barrier{0, 1}, 0);
  coord.on_event(buf(0, 10), 50);  // held
  coord.on_event(buf(0, 11), 60);  // held

  auto switched = coord.poll(150); // budget exceeded
  CHECK(coord.mode() == AlignmentMode::Unaligned);
  auto released = actions_of<ForwardBuffer>(switched);
  CHECK(released.size() == 2); // held buffers overtake the barrier

  CHECK(coord.evidence_log().size() == 1);
  const ModeSwitchEvidence& ev = coord.evidence_log().front();
  CHECK(ev.checkpoint == 1);
  CHECK(ev.logical_time_ms == 150);
  CHECK(ev.from == AlignmentMode::Aligned);
  CHECK(ev.to == AlignmentMode::Unaligned);
  CHECK(ev.inflight_at_switch.size() == 1);
  CHECK(ev.inflight_at_switch[0].channel == 0);
  CHECK(ev.inflight_at_switch[0].buffers.size() == 2);
  CHECK(ev.inflight_at_switch[0].buffers[0].seq == 10);
  CHECK(ev.inflight_at_switch[0].buffers[1].seq == 11);

  // Buffers arriving after the switch on the blocked channel are forwarded
  // immediately and captured as in-flight state.
  auto a = coord.on_event(buf(0, 12), 160);
  CHECK(actions_of<ForwardBuffer>(a).size() == 1);

  auto done = coord.on_event(Barrier{1, 1}, 170);
  auto completed = actions_of<CompleteCheckpoint>(done);
  CHECK(completed.size() == 1);
  const CheckpointSnapshot& snap = completed[0]->snapshot;
  CHECK(snap.mode == AlignmentMode::Unaligned);
  CHECK(snap.channel_states.size() == 1);
  CHECK(snap.channel_states[0].channel == 0);
  CHECK(snap.channel_states[0].buffers.size() == 3); // seq 10, 11, 12
}

// 3. A repeated barrier for the same (channel, checkpoint) is idempotent.
void test_duplicate_barrier_idempotent() {
  BarrierCoordinator coord(2, 1000);

  coord.on_event(Barrier{0, 5}, 0);
  auto dup = coord.on_event(Barrier{0, 5}, 10);
  CHECK(dup.empty());
  CHECK(coord.alignment_in_progress());

  auto done = coord.on_event(Barrier{1, 5}, 20);
  CHECK(actions_of<CompleteCheckpoint>(done).size() == 1);
  CHECK(coord.last_completed() == 5);

  // Replaying the whole epoch after completion changes nothing either.
  auto stale = coord.on_event(Barrier{0, 5}, 30);
  CHECK(stale.empty());
  CHECK(!coord.alignment_in_progress());
}

// 4. A newer checkpoint supersedes a pending older one, and late barriers
//    of the old epoch never block the new generation.
void test_newer_epoch_supersedes_older() {
  BarrierCoordinator coord(2, 1000);

  coord.on_event(Barrier{0, 1}, 0);   // epoch 1 pending on channel 0
  coord.on_event(buf(0, 10), 10);     // held for epoch 1

  auto supersede = coord.on_event(Barrier{0, 2}, 20);
  auto aborted = actions_of<AbortCheckpoint>(supersede);
  CHECK(aborted.size() == 1);
  CHECK(aborted[0]->checkpoint == 1);
  CHECK(aborted[0]->superseded_by == 2);
  // Held data of the aborted epoch is released as plain data.
  CHECK(actions_of<ForwardBuffer>(supersede).size() == 1);

  // A straggler barrier of the old epoch is ignored.
  auto stale = coord.on_event(Barrier{1, 1}, 30);
  CHECK(stale.empty());
  CHECK(coord.alignment_in_progress());

  auto done = coord.on_event(Barrier{1, 2}, 40);
  auto completed = actions_of<CompleteCheckpoint>(done);
  CHECK(completed.size() == 1);
  CHECK(completed[0]->snapshot.checkpoint == 2);
  CHECK(coord.last_completed() == 2);
}

// 5. Recovery from an unaligned snapshot replays exactly the captured
//    in-flight buffers: nothing lost, nothing duplicated.
void test_recovery_no_loss_no_duplication() {
  BarrierCoordinator coord(3, 100);

  coord.on_event(Barrier{0, 7}, 0);
  coord.on_event(buf(0, 100), 10); // held, then overtakes
  coord.on_event(buf(1, 200), 20); // normal data, before barrier on ch1
  coord.poll(150);                 // budget exceeded: switch to unaligned
  coord.on_event(buf(0, 101), 160); // overtaking
  coord.on_event(Barrier{1, 7}, 170);
  coord.on_event(buf(1, 201), 180); // overtaking on ch1
  auto done = coord.on_event(Barrier{2, 7}, 190);

  auto completed = actions_of<CompleteCheckpoint>(done);
  CHECK(completed.size() == 1);
  const CheckpointSnapshot& snap = completed[0]->snapshot;

  auto plan = BarrierCoordinator::restore_plan(snap);
  std::multiset<SeqNo> replayed;
  for (const ChannelInflight& channel : plan) {
    for (const Buffer& b : channel.buffers) {
      replayed.insert(b.seq);
    }
  }
  // Exactly the overtaking buffers, each exactly once.
  CHECK(replayed == std::multiset<SeqNo>({100, 101, 201}));
}

// 6. Mode-switch evidence serializes to a durable JSON audit record.
void test_evidence_json() {
  BarrierCoordinator coord(2, 10);
  coord.on_event(Barrier{0, 3}, 0);
  coord.on_event(buf(0, 42), 1);
  coord.poll(100);

  CHECK(coord.evidence_log().size() == 1);
  std::string json =
      BarrierCoordinator::evidence_to_json(coord.evidence_log().front());
  CHECK(json.find("\"checkpoint\":3") != std::string::npos);
  CHECK(json.find("\"from\":\"aligned\"") != std::string::npos);
  CHECK(json.find("\"to\":\"unaligned\"") != std::string::npos);
  CHECK(json.find("\"reason\":\"alignment_budget_exceeded\"") !=
        std::string::npos);
  CHECK(json.find("\"channel\":0") != std::string::npos);
  CHECK(json.find("42") != std::string::npos);
}

} // namespace

int main() {
  test_aligned_happy_path();
  test_unaligned_switch_on_budget_exceeded();
  test_duplicate_barrier_idempotent();
  test_newer_epoch_supersedes_older();
  test_recovery_no_loss_no_duplication();
  test_evidence_json();

  if (g_failures != 0) {
    std::cerr << g_failures << " check(s) failed" << std::endl;
    return EXIT_FAILURE;
  }
  std::cout << "all barrier coordinator tests passed" << std::endl;
  return EXIT_SUCCESS;
}
