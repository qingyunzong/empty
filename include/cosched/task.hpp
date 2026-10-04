#pragma once

#include <coroutine>
#include <exception>
#include <utility>

#include "frame_stats.hpp"
#include "scheduler.hpp"

namespace cosched {

// Minimal task type. Destroying a suspended Task unregisters its waiter from
// the scheduler before destroying the coroutine frame.
class Task {
public:
    struct promise_type {
        Scheduler* sched = nullptr;

        template <typename... Args>
        explicit promise_type(Scheduler& s, Args&&...) : sched(&s) {}
        promise_type() = default;

        Task get_return_object() {
            return Task{std::coroutine_handle<promise_type>::from_promise(*this)};
        }

        std::suspend_always initial_suspend() noexcept { return {}; }

        struct FinalAwaiter {
            promise_type* self;
            bool await_ready() noexcept { return false; }
            template <typename P>
            std::coroutine_handle<> await_suspend(std::coroutine_handle<P> h) noexcept {
                if (self->sched) self->sched->unregister_by_handle(h);
                return std::noop_coroutine();
            }
            void await_resume() noexcept {}
        };
        FinalAwaiter final_suspend() noexcept { return FinalAwaiter{this}; }

        void return_void() noexcept {}
        void unhandled_exception() { std::terminate(); }

        void* operator new(std::size_t n) {
            void* p = ::operator new(n);
            stats().record_alloc(p);
            return p;
        }
        void operator delete(void* p, std::size_t n) noexcept {
            stats().record_release(p);
            ::operator delete(p, n);
        }
        void operator delete(void* p) noexcept {
            stats().record_release(p);
            ::operator delete(p);
        }
    };

    Task() = default;
    explicit Task(std::coroutine_handle<promise_type> h) : handle_(h) {}
    Task(Task&& o) noexcept : handle_(std::exchange(o.handle_, {})) {}
    Task& operator=(Task&& o) noexcept {
        if (this != &o) {
            reset();
            handle_ = std::exchange(o.handle_, {});
        }
        return *this;
    }
    Task(const Task&) = delete;
    Task& operator=(const Task&) = delete;
    ~Task() { reset(); }

    void start() {
        if (auto* s = handle_.promise().sched) s->post(handle_);
    }
    bool done() const { return !handle_ || handle_.done(); }

private:
    void reset() {
        if (!handle_) return;
        if (auto* s = handle_.promise().sched) s->unregister_by_handle(handle_);
        handle_.destroy();
        handle_ = {};
    }

    std::coroutine_handle<promise_type> handle_;
};

} // namespace cosched
