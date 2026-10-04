#pragma once

#include <coroutine>
#include <cstdint>
#include <memory>
#include <unordered_map>
#include <vector>

#include "frame_stats.hpp"

namespace cosched {

struct OpState {
    bool completed = false;
};

// Manual event loop. Owns a ready queue and a waiter registry.
// Completion and cancellation race on a waiter: the first claim wins and the
// waiter is erased, so it can be resumed at most once.
class Scheduler {
public:
    using WaiterId = std::uint64_t;
    static constexpr WaiterId kInvalid = 0;

    void post(std::coroutine_handle<> h) {
        if (closed_ || !h) return; // rejected after shutdown: no dangling handles
        ready_.push_back(h);
    }

    WaiterId register_waiter(std::coroutine_handle<> h, std::shared_ptr<OpState> state) {
        if (closed_) return kInvalid;
        WaiterId id = next_id_++;
        waiters_.emplace(id, Waiter{h, std::move(state)});
        by_handle_.emplace(h.address(), id);
        return id;
    }

    // Called when a suspended task is destroyed: revoke its registration.
    void unregister_by_handle(std::coroutine_handle<> h) {
        auto it = by_handle_.find(h.address());
        if (it == by_handle_.end()) return;
        waiters_.erase(it->second);
        by_handle_.erase(it);
    }

    bool complete(WaiterId id) { return claim(id, true); }
    bool cancel(WaiterId id) { return claim(id, false); }

    std::size_t pending_waiters() const { return waiters_.size(); }
    std::size_t pending_ready() const { return ready_.size(); }

    // Runs one event-loop frame: drains the current ready queue.
    std::size_t run_frame() {
        stats().begin_frame(frame_index_++);
        std::vector<std::coroutine_handle<>> batch;
        batch.swap(ready_);
        for (auto h : batch)
            if (h && !h.done()) h.resume();
        return batch.size();
    }

    // Cancels every pending waiter exactly once, drains the loop, and rejects
    // any further post/register calls. Afterwards no dangling handles remain.
    void shutdown() {
        closed_ = true;
        for (auto& [id, w] : waiters_) {
            w.state->completed = false; // cancelled
            ready_.push_back(w.handle);
        }
        waiters_.clear();
        by_handle_.clear();
        while (!ready_.empty()) run_frame();
    }

    bool no_dangling() const { return waiters_.empty() && by_handle_.empty() && ready_.empty(); }
    bool closed() const { return closed_; }

private:
    struct Waiter {
        std::coroutine_handle<> handle;
        std::shared_ptr<OpState> state;
    };

    // First claim wins; the waiter is erased so it cannot be claimed again.
    bool claim(WaiterId id, bool completed) {
        auto it = waiters_.find(id);
        if (it == waiters_.end()) return false;
        it->second.state->completed = completed;
        auto h = it->second.handle;
        by_handle_.erase(h.address());
        waiters_.erase(it);
        if (!closed_) ready_.push_back(h);
        return true;
    }

    bool closed_ = false;
    WaiterId next_id_ = 1;
    std::size_t frame_index_ = 0;
    std::vector<std::coroutine_handle<>> ready_;
    std::unordered_map<WaiterId, Waiter> waiters_;
    std::unordered_map<void*, WaiterId> by_handle_;
};

// Awaitable suspending the coroutine until complete()/cancel() fires on it.
// await_resume() returns true on completion, false on cancellation.
class WaitOp {
public:
    explicit WaitOp(Scheduler& s) : sched_(s), state_(std::make_shared<OpState>()) {}

    bool await_ready() const noexcept { return false; }
    bool await_suspend(std::coroutine_handle<> h) {
        id_ = sched_.register_waiter(h, state_);
        return id_ != Scheduler::kInvalid; // closed scheduler: resume immediately
    }
    bool await_resume() const noexcept { return state_->completed; }

    Scheduler::WaiterId id() const { return id_; }

private:
    Scheduler& sched_;
    std::shared_ptr<OpState> state_;
    Scheduler::WaiterId id_ = Scheduler::kInvalid;
};

// Awaitable re-queueing the coroutine on the next frame.
class YieldOp {
public:
    explicit YieldOp(Scheduler& s) : sched_(s) {}
    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) { sched_.post(h); }
    void await_resume() const noexcept {}

private:
    Scheduler& sched_;
};

} // namespace cosched
