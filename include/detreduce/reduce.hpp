#pragma once

#include <algorithm>
#include <atomic>
#include <barrier>
#include <cstddef>
#include <limits>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace detreduce {

// Cooperative cancellation token shared with a running reduction.
class cancel_token {
public:
    void request() noexcept { flag_.store(true, std::memory_order_relaxed); }
    bool requested() const noexcept { return flag_.load(std::memory_order_relaxed); }

private:
    std::atomic<bool> flag_{false};
};

struct chunk_error {
    std::size_t chunk = 0;  // lowest index among all failed chunks
    std::string message;
};

enum class reduce_status { ok, cancelled, failed };

template <typename T>
struct reduce_outcome {
    reduce_status status = reduce_status::ok;
    std::optional<T> value;           // set iff status == ok
    std::optional<chunk_error> error; // set iff status == failed
};

// Optional instrumentation, mainly for tests.
struct reduce_stats {
    std::atomic<std::size_t> live_buffers{0};    // buffers currently allocated
    std::atomic<std::size_t> peak_buffers{0};    // high-water mark
    std::atomic<std::size_t> barrier_phases{0};  // barrier phases completed
};

struct reduce_options {
    std::size_t chunk_size = 64;
    unsigned workers = 0;  // 0 => hardware_concurrency
    cancel_token* token = nullptr;
    reduce_stats* stats = nullptr;
};

namespace detail {

// Counts one allocated buffer in reduce_stats while alive.
class buffer_guard {
public:
    explicit buffer_guard(reduce_stats* s) noexcept : s_(s) {
        if (!s_) return;
        const std::size_t live = s_->live_buffers.fetch_add(1, std::memory_order_relaxed) + 1;
        std::size_t peak = s_->peak_buffers.load(std::memory_order_relaxed);
        while (peak < live &&
               !s_->peak_buffers.compare_exchange_weak(peak, live, std::memory_order_relaxed)) {
        }
    }
    ~buffer_guard() {
        if (s_) s_->live_buffers.fetch_sub(1, std::memory_order_relaxed);
    }
    buffer_guard(const buffer_guard&) = delete;
    buffer_guard& operator=(const buffer_guard&) = delete;

private:
    reduce_stats* s_;
};

}  // namespace detail

// Serial reference model of the fixed chunk tree. The parallel engine
// (tree_reduce) is required to produce exactly this value.
//
// Chunk c covers indices [c*chunk, min(n, (c+1)*chunk)); each chunk is
// left-folded, then chunk partials are combined pairwise left-to-right,
// level by level, an odd leftover carried up unchanged.
template <typename T, typename Map, typename Combine>
T serial_tree_reduce(std::size_t n, Map map, Combine combine, std::size_t chunk_size) {
    const std::size_t chunk = std::max<std::size_t>(1, chunk_size);
    const std::size_t nchunks = (n + chunk - 1) / chunk;
    if (nchunks == 0) return T{};
    std::vector<T> cur;
    cur.reserve(nchunks);
    for (std::size_t c = 0; c < nchunks; ++c) {
        const std::size_t lo = c * chunk;
        const std::size_t hi = std::min(n, lo + chunk);
        T acc = map(lo);
        for (std::size_t i = lo + 1; i < hi; ++i) acc = combine(acc, map(i));
        cur.push_back(std::move(acc));
    }
    std::vector<T> next;
    std::size_t m = nchunks;
    while (m > 1) {
        const std::size_t half = m / 2;
        next.clear();
        next.reserve((m + 1) / 2);
        for (std::size_t j = 0; j < half; ++j) next.push_back(combine(cur[2 * j], cur[2 * j + 1]));
        if (m % 2 != 0) next.push_back(std::move(cur[m - 1]));
        cur.swap(next);
        m = (m + 1) / 2;
    }
    return std::move(cur[0]);
}

// Deterministic parallel reduction over a fixed chunk tree.
//
// Guarantees:
//  - The result is identical to serial_tree_reduce with the same chunk
//    size, no matter in which order threads complete chunks or arrive
//    at the internal barriers.
//  - If the cancel token is requested, the outcome is `cancelled`
//    (no value) and all internal buffers are released before return.
//  - If one or more chunks fail (map throws), the outcome is `failed`
//    and error->chunk is the smallest failing chunk index.
//  - Failure takes precedence over cancellation if both occur.
template <typename T, typename Map, typename Combine>
reduce_outcome<T> tree_reduce(std::size_t n, Map map, Combine combine,
                              const reduce_options& opts = {}) {
    const std::size_t chunk = std::max<std::size_t>(1, opts.chunk_size);
    const std::size_t nchunks = (n + chunk - 1) / chunk;
    if (nchunks == 0) return {reduce_status::ok, T{}, std::nullopt};

    unsigned wc = opts.workers;
    if (wc == 0) {
        wc = std::thread::hardware_concurrency();
        if (wc == 0) wc = 1;
    }
    const unsigned W = static_cast<unsigned>(std::min<std::size_t>(wc, nchunks));

    // Level buffers of the fixed tree (the only heap buffers used).
    std::vector<std::optional<T>> cur(nchunks), next(nchunks);
    detail::buffer_guard guard_cur(opts.stats), guard_next(opts.stats);

    std::atomic<std::size_t> next_chunk{0};
    std::atomic<bool> failed{false};
    std::atomic<std::size_t> min_fail{std::numeric_limits<std::size_t>::max()};
    std::mutex msg_mutex;
    std::string fail_msg;

    std::size_t m = nchunks;  // active entries in `cur` (barrier-synchronized)
    bool phase_stop = false;  // written only by barrier completion steps

    auto stop_requested = [&]() noexcept {
        return failed.load(std::memory_order_relaxed) ||
               (opts.token != nullptr && opts.token->requested());
    };

    auto record_failure = [&](std::size_t c, const char* what) {
        failed.store(true, std::memory_order_relaxed);
        std::size_t cur_min = min_fail.load(std::memory_order_relaxed);
        while (c < cur_min &&
               !min_fail.compare_exchange_weak(cur_min, c, std::memory_order_relaxed)) {
        }
        std::lock_guard lk(msg_mutex);
        if (c <= min_fail.load(std::memory_order_relaxed)) fail_msg = what;
    };

    auto bump_phases = [&]() noexcept {
        if (opts.stats) opts.stats->barrier_phases.fetch_add(1, std::memory_order_relaxed);
    };

    // Two barriers per tree level: the first publishes a uniform stop
    // decision, the second advances the level (m, cur/next swap) exactly
    // once per phase in its completion step.
    std::barrier sync_stop(W, [&]() noexcept {
        phase_stop = stop_requested();
        bump_phases();
    });
    std::barrier sync_level(W, [&]() noexcept {
        m = (m + 1) / 2;
        cur.swap(next);
        bump_phases();
    });

    auto worker = [&](unsigned wid) {
        // Phase 1: compute chunk partials into fixed slots cur[c].
        for (;;) {
            if (stop_requested()) break;
            const std::size_t c = next_chunk.fetch_add(1, std::memory_order_relaxed);
            if (c >= nchunks) break;
            const std::size_t lo = c * chunk;
            const std::size_t hi = std::min(n, lo + chunk);
            try {
                T acc = map(lo);
                bool aborted = false;
                for (std::size_t i = lo + 1; i < hi; ++i) {
                    if (stop_requested()) {
                        aborted = true;
                        break;
                    }
                    acc = combine(acc, map(i));
                }
                if (aborted) break;
                cur[c] = std::move(acc);
            } catch (const std::exception& e) {
                record_failure(c, e.what());
                break;
            } catch (...) {
                record_failure(c, "unknown exception");
                break;
            }
        }
        // Phase 2: combine partials level by level along the fixed tree.
        for (;;) {
            sync_stop.arrive_and_wait();
            if (phase_stop || m <= 1) break;
            const std::size_t half = m / 2;
            for (std::size_t j = wid; j < half; j += W)
                next[j] = combine(*cur[2 * j], *cur[2 * j + 1]);
            if ((m & 1) != 0 && wid == 0) next[half] = std::move(cur[m - 1]);
            sync_level.arrive_and_wait();
        }
    };

    {
        std::vector<std::thread> pool;
        pool.reserve(W);
        for (unsigned t = 0; t < W; ++t) pool.emplace_back(worker, t);
        for (auto& th : pool) th.join();
    }

    reduce_outcome<T> out;
    if (failed.load(std::memory_order_relaxed)) {
        out.status = reduce_status::failed;
        out.error = chunk_error{min_fail.load(std::memory_order_relaxed), fail_msg};
    } else if (opts.token != nullptr && opts.token->requested()) {
        out.status = reduce_status::cancelled;
    } else {
        out.status = reduce_status::ok;
        out.value = std::move(cur[0]);
    }
    return out;  // cur/next and their guards release all buffers here
}

}  // namespace detreduce
