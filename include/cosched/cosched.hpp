#pragma once

// cosched: a minimal C++20 coroutine scheduling library with a manual,
// frame-based event loop.
//
// Design guarantees:
//  * Completion vs. cancellation race: every waiter is resumed exactly once.
//    State transitions (pending -> completed | cancelled) are atomic under a
//    mutex; whoever transitions first claims the waiter, the loser no-ops.
//  * Destroying a suspended task unregisters its pending operation, so the
//    scheduler never touches a dead coroutine handle.
//  * shutdown() cancels every registered operation, resumes its waiter with
//    operation_cancelled, drains the ready queue and rejects new work, so no
//    dangling handles remain.
//  * Every coroutine-frame free is attributed to the frame in which it
//    happens (frees outside a frame are deferred to the next one).
//
// Lifetime rule: the scheduler must outlive all tasks and operations.

#include <coroutine>
#include <cstdint>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

namespace cosched {

class operation;
class scheduler;

struct operation_cancelled : std::runtime_error {
    operation_cancelled() : std::runtime_error("operation cancelled") {}
};

namespace detail {
struct promise_base {
    scheduler* sched = nullptr;
    std::shared_ptr<operation> current_op;  // op the coroutine is suspended on
    std::exception_ptr error;

    std::suspend_always initial_suspend() noexcept { return {}; }
    std::suspend_always final_suspend() noexcept { return {}; }
    void unhandled_exception() { error = std::current_exception(); }

    ~promise_base();  // counts the coroutine-frame free on the scheduler
};
}  // namespace detail

class scheduler {
public:
    struct frame_stats {
        std::uint64_t frame = 0;
        std::size_t posted = 0;        // work items drained in this frame
        std::size_t resumed = 0;       // coroutine resumes executed in this frame
        std::size_t freed = 0;         // coroutine frames freed (attributed here)
        std::size_t timers_fired = 0;  // delay operations completed by this frame
    };

    scheduler() = default;
    scheduler(const scheduler&) = delete;
    scheduler& operator=(const scheduler&) = delete;
    ~scheduler();  // shuts down if needed; leaves no dangling handles

    // Manual event loop.
    frame_stats run_frame();  // fire due timers, drain the current ready snapshot
    void run_until_idle();    // run frames until the ready queue is empty
    void shutdown();          // cancel all registered ops, drain, refuse new work

    bool is_shutdown() const { return shutdown_; }
    std::uint64_t frame_index() const { return frame_; }
    std::size_t pending_operations() const { return registry_.size(); }
    const std::vector<frame_stats>& history() const { return history_; }
    std::size_t total_resumed() const { return total_resumed_; }
    std::size_t total_freed() const { return total_freed_; }

    // Completion sources.
    std::shared_ptr<operation> make_operation();              // manual completion
    std::shared_ptr<operation> async_delay(std::uint64_t frames);  // fires in N frames

    // Public posting entry point; rejected after shutdown.
    bool post(std::function<void()> fn);

    // Internal API used by operation / task.
    void resume_counted(std::coroutine_handle<> h);
    void register_operation(std::shared_ptr<operation> op);
    void unregister_operation(operation* op) { registry_.erase(op); }
    void notify_frame_freed();

private:
    friend class operation;
    // Bypasses the shutdown check; used for cancellation/completion delivery
    // that is already in flight while shutdown() drains the loop.
    void post_internal(std::function<void()> fn) { ready_.push_back(std::move(fn)); }

    std::deque<std::function<void()>> ready_;
    std::unordered_map<operation*, std::shared_ptr<operation>> registry_;
    std::vector<std::pair<std::uint64_t, std::shared_ptr<operation>>> timers_;
    std::vector<frame_stats> history_;
    frame_stats* active_ = nullptr;
    std::uint64_t frame_ = 0;
    std::size_t deferred_freed_ = 0;
    std::size_t total_resumed_ = 0;
    std::size_t total_freed_ = 0;
    bool shutdown_ = false;
};

class operation : public std::enable_shared_from_this<operation> {
public:
    enum class state { pending, completed, cancelled };

    explicit operation(scheduler& s) : sched_(&s) {}
    operation(const operation&) = delete;
    operation& operator=(const operation&) = delete;
    ~operation() = default;  // registered ops are kept alive by the registry

    state get_state() const {
        std::lock_guard g(mu_);
        return state_;
    }

    // Completer side: pending -> completed, posts exactly one resume if a
    // waiter is registered. Returns false if the race was already lost.
    bool complete();

    // Task-destroy side: any state -> cancelled, claims the waiter so an
    // in-flight posted resume no-ops. Never resumes (the caller destroys the
    // coroutine frame itself). Returns false if already cancelled.
    bool cancel();

    struct wait_awaitable {
        std::shared_ptr<operation> op;

        bool await_ready() const noexcept { return op->get_state() != state::pending; }

        template <typename Promise>
        bool await_suspend(std::coroutine_handle<Promise> h) {
            {
                std::lock_guard g(op->mu_);
                if (op->state_ != state::pending) return false;  // lost the race
                if (op->sched_->is_shutdown()) return false;
                op->waiter_ = h;
            }
            op->sched_->register_operation(op);
            h.promise().current_op = op;
            return true;
        }

        void await_resume() const {
            state s = op->get_state();
            if (s == state::cancelled || (s == state::pending && op->sched_->is_shutdown()))
                throw operation_cancelled{};
        }
    };

    wait_awaitable wait() { return wait_awaitable{shared_from_this()}; }

private:
    friend class scheduler;
    // Shutdown side: pending -> cancelled and posts a resume so the waiter
    // unwinds with operation_cancelled. Claims the waiter exactly once.
    void cancel_and_resume();

    scheduler* sched_;
    mutable std::mutex mu_;
    state state_ = state::pending;
    std::coroutine_handle<> waiter_{};
};

// ---------------------------------------------------------------------------
// operation implementation
// ---------------------------------------------------------------------------

inline bool operation::complete() {
    bool has_waiter;
    {
        std::lock_guard g(mu_);
        if (state_ != state::pending) return false;
        state_ = state::completed;
        has_waiter = waiter_ != nullptr;
    }
    sched_->unregister_operation(this);
    if (has_waiter) {
        sched_->post_internal([self = shared_from_this()] {
            std::coroutine_handle<> h;
            {
                std::lock_guard g(self->mu_);
                // A cancel() may have claimed the waiter after complete()
                // posted this resume; only the state winner may resume.
                if (self->state_ == state::completed)
                    h = std::exchange(self->waiter_, {});
            }
            if (h) self->sched_->resume_counted(h);
        });
    }
    return true;
}

inline bool operation::cancel() {
    {
        std::lock_guard g(mu_);
        if (state_ == state::cancelled) return false;
        state_ = state::cancelled;
        waiter_ = {};
    }
    sched_->unregister_operation(this);
    return true;
}

inline void operation::cancel_and_resume() {
    std::coroutine_handle<> h;
    {
        std::lock_guard g(mu_);
        if (state_ == state::cancelled) return;
        state_ = state::cancelled;
        h = std::exchange(waiter_, {});
    }
    sched_->unregister_operation(this);
    if (h) {
        sched_->post_internal([self = shared_from_this(), h] {
            self->sched_->resume_counted(h);
        });
    }
}

// ---------------------------------------------------------------------------
// scheduler implementation
// ---------------------------------------------------------------------------

inline bool scheduler::post(std::function<void()> fn) {
    if (shutdown_) return false;
    ready_.push_back(std::move(fn));
    return true;
}

inline void scheduler::resume_counted(std::coroutine_handle<> h) {
    if (active_) ++active_->resumed;
    ++total_resumed_;
    h.resume();
}

inline void scheduler::notify_frame_freed() {
    if (active_) ++active_->freed;
    else ++deferred_freed_;
    ++total_freed_;
}

inline scheduler::frame_stats scheduler::run_frame() {
    ++frame_;
    frame_stats st;
    st.frame = frame_;
    st.freed = deferred_freed_;
    deferred_freed_ = 0;
    active_ = &st;

    for (auto it = timers_.begin(); it != timers_.end();) {
        if (it->first <= frame_) {
            auto op = std::move(it->second);
            it = timers_.erase(it);
            if (op->complete()) ++st.timers_fired;
        } else {
            ++it;
        }
    }

    std::deque<std::function<void()>> work;
    work.swap(ready_);
    st.posted = work.size();
    while (!work.empty()) {
        auto fn = std::move(work.front());
        work.pop_front();
        fn();
    }

    active_ = nullptr;
    history_.push_back(st);
    return st;
}

inline void scheduler::run_until_idle() {
    while (!ready_.empty()) run_frame();
}

inline void scheduler::shutdown() {
    if (shutdown_) return;
    shutdown_ = true;
    std::vector<std::shared_ptr<operation>> ops;
    ops.reserve(registry_.size());
    for (auto& entry : registry_) ops.push_back(entry.second);
    timers_.clear();
    for (auto& op : ops) op->cancel_and_resume();
    run_until_idle();
}

inline scheduler::~scheduler() {
    shutdown();
}

inline std::shared_ptr<operation> scheduler::make_operation() {
    return std::make_shared<operation>(*this);
}

inline std::shared_ptr<operation> scheduler::async_delay(std::uint64_t frames) {
    auto op = make_operation();
    timers_.emplace_back(frame_ + frames, op);
    return op;
}

inline void scheduler::register_operation(std::shared_ptr<operation> op) {
    if (shutdown_) return;
    if (op->get_state() != operation::state::pending) return;  // lost the race
    registry_.emplace(op.get(), std::move(op));
}

inline detail::promise_base::~promise_base() {
    if (sched) sched->notify_frame_freed();
}

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

class task {
public:
    struct promise_type : detail::promise_base {
        // Coroutines must take `scheduler&` as their first parameter.
        template <typename... Args>
        explicit promise_type(scheduler& s, Args&&...) {
            sched = &s;
        }

        task get_return_object();
        void return_void() noexcept {}
    };

    using handle_type = std::coroutine_handle<promise_type>;

    task() = default;
    explicit task(handle_type h) : h_(h) {}
    task(task&& other) noexcept : h_(std::exchange(other.h_, {})) {}
    task& operator=(task&& other) noexcept {
        if (this != &other) {
            reset();
            h_ = std::exchange(other.h_, {});
        }
        return *this;
    }
    task(const task&) = delete;
    task& operator=(const task&) = delete;
    ~task() { reset(); }

    void start();  // schedule the initial resume on the scheduler
    void reset();  // cancel the pending op (if suspended) and free the frame

    bool valid() const { return h_ != nullptr; }
    bool done() const { return !h_ || h_.done(); }

    void rethrow_if_error() const {
        if (h_ && h_.promise().error) std::rethrow_exception(h_.promise().error);
    }

private:
    handle_type h_{};
};

inline task task::promise_type::get_return_object() {
    return task{handle_type::from_promise(*this)};
}

inline void task::start() {
    handle_type h = h_;
    scheduler* s = h.promise().sched;
    s->post([h, s] { s->resume_counted(h); });
}

inline void task::reset() {
    if (!h_) return;
    promise_type& p = h_.promise();
    if (!h_.done() && p.current_op) p.current_op->cancel();  // revoke registration
    std::exchange(h_, {}).destroy();
}

}  // namespace cosched
