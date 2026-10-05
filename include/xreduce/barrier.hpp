#pragma once

#include <condition_variable>
#include <cstddef>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace xreduce {

// Reusable phase barrier. Threads may arrive in any order; the last
// arrival runs the completion callback (while holding the internal
// lock) and then releases everyone into the next phase.
class PhaseBarrier {
public:
  explicit PhaseBarrier(std::ptrdiff_t parties) : expected_(parties) {}

  PhaseBarrier(const PhaseBarrier &) = delete;
  PhaseBarrier &operator=(const PhaseBarrier &) = delete;

  using Completion = std::function<void()>;
  using ArrivalRecorder = std::function<void(std::thread::id, std::size_t)>;

  void set_completion(Completion fn) { completion_ = std::move(fn); }

  // Optional test hook: called with (thread id, arrival sequence number)
  // for every arrival, in actual arrival order.
  void set_arrival_recorder(ArrivalRecorder fn) { recorder_ = std::move(fn); }

  void arrive_and_wait() {
    std::unique_lock lock(mutex_);
    std::size_t generation = generation_;
    if (recorder_)
      recorder_(std::this_thread::get_id(), arrival_seq_++);
    if (++arrived_ == expected_) {
      arrived_ = 0;
      ++generation_;
      if (completion_)
        completion_();
      lock.unlock();
      cv_.notify_all();
    } else {
      cv_.wait(lock, [&] { return generation_ != generation; });
    }
  }

private:
  std::mutex mutex_;
  std::condition_variable cv_;
  std::ptrdiff_t expected_;
  std::ptrdiff_t arrived_ = 0;
  std::size_t generation_ = 0;
  std::size_t arrival_seq_ = 0;
  Completion completion_;
  ArrivalRecorder recorder_;
};

} // namespace xreduce
