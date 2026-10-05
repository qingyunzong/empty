#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <exception>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>
#include <vector>

#include "barrier.hpp"

namespace xreduce {

// Cooperative cancellation handle shared with a running reduction.
class CancelToken {
public:
  void cancel() noexcept { cancelled_.store(true, std::memory_order_release); }
  bool cancelled() const noexcept {
    return cancelled_.load(std::memory_order_acquire);
  }

private:
  std::atomic<bool> cancelled_{false};
};

// Counts live partial-result buffer slots; used to verify that all
// buffers are released when a reduction finishes or is cancelled.
class BufferTracker {
public:
  void acquire(std::size_t n) noexcept {
    live_.fetch_add(n, std::memory_order_relaxed);
  }
  void release(std::size_t n) noexcept {
    live_.fetch_sub(n, std::memory_order_relaxed);
  }
  std::size_t live() const noexcept {
    return live_.load(std::memory_order_relaxed);
  }

private:
  std::atomic<std::size_t> live_{0};
};

struct ReduceOptions {
  std::size_t block_size = 64;
  unsigned num_threads = 0; // 0 => hardware_concurrency
};

template <typename T> struct ReduceOutcome {
  std::optional<T> value;                  // empty when cancelled/failed
  std::optional<std::size_t> failed_block; // smallest failing block index
  bool cancelled = false;
};

namespace detail {

// Vector of partial-result slots whose allocation is accounted in a
// BufferTracker. Releasing is idempotent; the destructor releases.
template <typename T> class TrackedBuffer {
public:
  TrackedBuffer(std::size_t n, BufferTracker *tracker)
      : slots_(n), tracker_(tracker) {
    if (tracker_)
      tracker_->acquire(n);
  }
  ~TrackedBuffer() { release(); }

  TrackedBuffer(const TrackedBuffer &) = delete;
  TrackedBuffer &operator=(const TrackedBuffer &) = delete;

  std::vector<std::optional<T>> &slots() { return slots_; }

  void release() {
    if (tracker_ && !slots_.empty())
      tracker_->release(slots_.size());
    std::vector<std::optional<T>>().swap(slots_);
  }

private:
  std::vector<std::optional<T>> slots_;
  BufferTracker *tracker_;
};

} // namespace detail

// Deterministic parallel reduction over indices [0, n).
//
// The index range is split into fixed-size blocks. Each block is folded
// serially (in index order) into one partial; partials are then combined
// by a fixed pairwise binary tree (adjacent pairs, level by level). The
// combination order depends only on the tree shape, never on thread
// scheduling, so the result is identical for any thread completion order.
//
//   map(i)     -> std::optional<T>; nullopt marks the element's block failed
//   combine    -> T(const T&, const T&)
//
// On block failure the smallest failing block index is reported and no
// value is returned. On cancellation no value is returned and all
// internal buffers are released before the call returns.
template <typename T, typename Map, typename Combine>
ReduceOutcome<T> parallel_reduce(std::size_t n, Map map, Combine combine,
                                 ReduceOptions opts = {},
                                 CancelToken *token = nullptr,
                                 BufferTracker *tracker = nullptr) {
  const std::size_t block = std::max<std::size_t>(1, opts.block_size);
  const std::size_t num_blocks = (n + block - 1) / block;

  ReduceOutcome<T> outcome;
  if (num_blocks == 0)
    return outcome; // empty input: no value

  unsigned hw = opts.num_threads != 0
                    ? opts.num_threads
                    : std::max(1u, std::thread::hardware_concurrency());
  const unsigned nthreads =
      std::min<unsigned>(hw, static_cast<unsigned>(num_blocks));

  std::atomic<bool> stop{false};
  std::atomic<std::size_t> failed_block{~std::size_t{0}};
  auto cancelled = [&] {
    return stop.load(std::memory_order_acquire) ||
           (token != nullptr && token->cancelled());
  };

  detail::TrackedBuffer<T> cur(num_blocks, tracker);
  detail::TrackedBuffer<T> next(num_blocks, tracker);

  PhaseBarrier barrier(nthreads);
  std::atomic<std::size_t> next_item{0};

  // Shared tree state, mutated only inside the barrier completion (which
  // runs under the barrier lock) and read by workers only after the
  // barrier releases them, so every read is synchronized.
  std::size_t width = num_blocks;
  bool tree_phase = false;
  bool finished = false;

  barrier.set_completion([&] {
    if (!tree_phase) {
      tree_phase = true; // first barrier: end of block-compute level
    } else {
      cur.slots().swap(next.slots());
      for (auto &slot : next.slots())
        slot.reset();
      width = (width + 1) / 2;
    }
    next_item.store(0, std::memory_order_relaxed);
    if (width <= 1 || cancelled())
      finished = true;
  });

  std::exception_ptr worker_error;
  std::mutex error_mutex;

  auto run_level = [&](std::size_t count, auto &&work) {
    for (;;) {
      std::size_t i = next_item.fetch_add(1, std::memory_order_relaxed);
      if (i >= count || cancelled())
        break;
      try {
        work(i);
      } catch (...) {
        {
          std::lock_guard guard(error_mutex);
          if (!worker_error)
            worker_error = std::current_exception();
        }
        stop.store(true, std::memory_order_release);
      }
    }
    barrier.arrive_and_wait();
  };

  auto compute_block = [&](std::size_t b) {
    std::size_t lo = b * block;
    std::size_t hi = std::min(n, lo + block);
    std::optional<T> acc;
    for (std::size_t i = lo; i < hi; ++i) {
      if (cancelled())
        return;
      std::optional<T> v = map(i);
      if (!v) {
        std::size_t cur_min = failed_block.load(std::memory_order_relaxed);
        while (cur_min > b &&
               !failed_block.compare_exchange_weak(cur_min, b))
          ;
        stop.store(true, std::memory_order_release);
        return;
      }
      acc = acc ? combine(*acc, *v) : *v;
    }
    if (acc)
      cur.slots()[b] = std::move(acc);
  };

  auto combine_pair = [&](std::size_t i) {
    auto &a = cur.slots()[2 * i];
    if (2 * i + 1 < width) {
      auto &b = cur.slots()[2 * i + 1];
      if (a && b)
        next.slots()[i] = combine(*a, *b);
      else if (a)
        next.slots()[i] = std::move(a);
      else
        next.slots()[i] = std::move(b);
    } else {
      next.slots()[i] = std::move(a);
    }
  };

  auto thread_main = [&] {
    run_level(num_blocks, compute_block);
    while (!finished) {
      std::size_t out_width = (width + 1) / 2;
      run_level(out_width, combine_pair);
    }
  };

  {
    std::vector<std::thread> pool;
    pool.reserve(nthreads > 0 ? nthreads - 1 : 0);
    for (unsigned t = 1; t < nthreads; ++t)
      pool.emplace_back(thread_main);
    thread_main();
    for (auto &th : pool)
      th.join();
  }

  if (worker_error)
    std::rethrow_exception(worker_error);

  std::size_t fb = failed_block.load(std::memory_order_relaxed);
  if (fb != ~std::size_t{0}) {
    outcome.failed_block = fb; // smallest failing block, no value
  } else if (cancelled()) {
    outcome.cancelled = true; // no value
  } else {
    outcome.value = std::move(cur.slots()[0]);
  }

  cur.release();
  next.release();
  return outcome;
}

// Serial reference model: the exact same fixed block tree, evaluated on
// a single thread. Used to cross-check the parallel implementation.
// Returns nullopt if any element mapping fails.
template <typename T, typename Map, typename Combine>
std::optional<T> serial_tree_reduce(std::size_t n, Map map, Combine combine,
                                    std::size_t block_size) {
  const std::size_t block = std::max<std::size_t>(1, block_size);
  const std::size_t num_blocks = (n + block - 1) / block;
  if (num_blocks == 0)
    return std::nullopt;

  std::vector<std::optional<T>> cur(num_blocks);
  for (std::size_t b = 0; b < num_blocks; ++b) {
    std::size_t lo = b * block;
    std::size_t hi = std::min(n, lo + block);
    std::optional<T> acc;
    for (std::size_t i = lo; i < hi; ++i) {
      std::optional<T> v = map(i);
      if (!v)
        return std::nullopt;
      acc = acc ? combine(*acc, *v) : *v;
    }
    cur[b] = std::move(acc);
  }

  std::size_t width = num_blocks;
  while (width > 1) {
    std::size_t out_width = (width + 1) / 2;
    std::vector<std::optional<T>> nxt(out_width);
    for (std::size_t i = 0; i < out_width; ++i) {
      if (2 * i + 1 < width)
        nxt[i] = combine(*cur[2 * i], *cur[2 * i + 1]);
      else
        nxt[i] = std::move(cur[2 * i]);
    }
    cur = std::move(nxt);
    width = out_width;
  }
  return std::move(cur[0]);
}

} // namespace xreduce
