#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dlks::formal {

// 一次 all-reduce 的描述信息，回调时交给通信层。
struct BucketInfo {
    std::uint64_t bucket_id = 0;
    std::size_t bytes = 0;
    std::vector<std::uint64_t> param_ids;
};

// 缓冲分配器接口：实现方负责统计在途字节，供内存上限校验。
class IBufferAllocator {
public:
    virtual ~IBufferAllocator() = default;
    virtual void* allocate(std::size_t bytes) = 0;
    virtual void deallocate(void* ptr, std::size_t bytes) noexcept = 0;
    virtual std::size_t live_bytes() const noexcept = 0;
    virtual std::size_t peak_bytes() const noexcept = 0;
    virtual std::size_t allocation_count() const noexcept = 0;
    virtual std::size_t deallocation_count() const noexcept = 0;
};

// 基于 ::operator new 的默认分配器，原子记录存活/峰值字节与分配次数。
class TrackingMallocAllocator final : public IBufferAllocator {
public:
    void* allocate(std::size_t bytes) override {
        void* ptr = ::operator new(bytes);
        const std::size_t live =
            live_.fetch_add(bytes, std::memory_order_acq_rel) + bytes;
        allocs_.fetch_add(1, std::memory_order_relaxed);
        std::size_t expected = peak_.load(std::memory_order_relaxed);
        while (expected < live &&
               !peak_.compare_exchange_weak(expected, live,
                                            std::memory_order_acq_rel,
                                            std::memory_order_relaxed)) {
        }
        return ptr;
    }

    void deallocate(void* ptr, std::size_t bytes) noexcept override {
        ::operator delete(ptr);
        live_.fetch_sub(bytes, std::memory_order_acq_rel);
        frees_.fetch_add(1, std::memory_order_relaxed);
    }

    std::size_t live_bytes() const noexcept override {
        return live_.load(std::memory_order_acquire);
    }
    std::size_t peak_bytes() const noexcept override {
        return peak_.load(std::memory_order_acquire);
    }
    std::size_t allocation_count() const noexcept override {
        return allocs_.load(std::memory_order_acquire);
    }
    std::size_t deallocation_count() const noexcept override {
        return frees_.load(std::memory_order_acquire);
    }

private:
    std::atomic<std::size_t> live_{0};
    std::atomic<std::size_t> peak_{0};
    std::atomic<std::size_t> allocs_{0};
    std::atomic<std::size_t> frees_{0};
};

// 引用计数的桶缓冲：调度器与通信层各持一份引用，最后一方释放时回收，
// 因此取消路径不会 double-free，也不会在通信层仍持有时提前回收。
class Buffer {
public:
    Buffer() = default;

    static Buffer create(IBufferAllocator& allocator, std::size_t bytes) {
        void* ptr = allocator.allocate(bytes);
        return Buffer(std::make_shared<Holder>(&allocator, ptr, bytes));
    }

    void* data() const noexcept { return holder_ ? holder_->ptr : nullptr; }
    std::size_t size() const noexcept { return holder_ ? holder_->size : 0; }
    bool valid() const noexcept { return static_cast<bool>(holder_); }

    void reset() noexcept { holder_.reset(); }

private:
    struct Holder {
        IBufferAllocator* allocator;
        void* ptr;
        std::size_t size;

        Holder(IBufferAllocator* alloc, void* p, std::size_t s) noexcept
            : allocator(alloc), ptr(p), size(s) {}

        ~Holder() {
            if (ptr != nullptr) {
                allocator->deallocate(ptr, size);
            }
        }

        Holder(const Holder&) = delete;
        Holder& operator=(const Holder&) = delete;
    };

    explicit Buffer(std::shared_ptr<Holder> holder) : holder_(std::move(holder)) {}

    std::shared_ptr<Holder> holder_;
};

struct SchedulerConfig {
    // 单个桶的目标容量上限（字节）；超限的单个参数独占一个桶。
    std::size_t bucket_capacity_bytes = 1u << 20;
    // 同时在途（已发射未完成）的桶数量上限，决定峰值内存。
    std::size_t max_inflight_buckets = 2;
};

// 通信层回调：发射一次异步 all-reduce，request_id 由调度器分配，
// 完成后通信层必须调用 GradientBucketScheduler::complete(request_id)。
// 实现方可保留 buffer 直到通信结束；约定该回调不抛异常。
using AllreduceLauncher =
    std::function<void(std::uint64_t request_id, Buffer buffer,
                       const BucketInfo& bucket)>;

// 取消回调：调度器放弃在途请求时调用，通信层应尽快中止该请求并释放自身引用。
using AllreduceAbort =
    std::function<void(std::uint64_t request_id, const BucketInfo& bucket)>;

// 梯度桶调度器。
//
// 生命周期：
//   1. register_tensor() 按反向传播预期就绪顺序登记参数（共享参数用同一
//      param_id 重复登记，字节只计一次，但每次登记都是一个就绪贡献）；
//   2. 反向计算中每个梯度累加完成调用 mark_ready(param_id)；
//   3. 全部登记结束调用 flush() 封尾并触发可发射桶；
//   4. 通信完成回调 complete(request_id)；
//   5. 异常路径调用 cancel()，幂等且线程安全。
class GradientBucketScheduler {
public:
    explicit GradientBucketScheduler(
        SchedulerConfig config, AllreduceLauncher launcher,
        std::shared_ptr<IBufferAllocator> allocator = nullptr,
        AllreduceAbort abort = nullptr)
        : config_(config),
          launcher_(std::move(launcher)),
          abort_(std::move(abort)),
          allocator_(allocator ? std::move(allocator)
                               : std::make_shared<TrackingMallocAllocator>()) {
        if (!launcher_) {
            throw std::invalid_argument("AllreduceLauncher must not be empty");
        }
        if (config_.bucket_capacity_bytes == 0 ||
            config_.max_inflight_buckets == 0) {
            throw std::invalid_argument("scheduler limits must be non-zero");
        }
    }

    GradientBucketScheduler(const GradientBucketScheduler&) = delete;
    GradientBucketScheduler& operator=(const GradientBucketScheduler&) = delete;

    // 登记一个反向贡献。同一 param_id 重复登记表示参数共享：
    // 字节仅首次计入桶，之后每次登记都要求一次 mark_ready。
    void register_tensor(std::uint64_t param_id, std::size_t bytes);

    // 封闭当前仍可追加的桶。
    void seal();

    // 登记结束后封尾，并尽可能发射已就绪的桶。
    void flush();

    // 一个梯度累加贡献完成。共享参数的全部贡献都完成后该参数才算就绪。
    void mark_ready(std::uint64_t param_id);

    // 通信层报告请求完成。取消后到达的完成事件返回 false，属于安全空操作。
    bool complete(std::uint64_t request_id);

    // 取消调度：停止发射新桶，放弃全部在途请求并触发 abort 回调。
    // 调度器持有的缓冲引用立即释放；通信层仍持有的引用在其中止后释放。
    // 幂等：重复调用为空操作。
    void cancel();

    std::size_t live_bytes() const noexcept { return allocator_->live_bytes(); }
    std::size_t peak_bytes() const noexcept { return allocator_->peak_bytes(); }
    std::size_t allocation_count() const noexcept {
        return allocator_->allocation_count();
    }
    std::size_t deallocation_count() const noexcept {
        return allocator_->deallocation_count();
    }

    std::size_t bucket_count() const {
        std::scoped_lock lock(mu_);
        return buckets_.size();
    }
    std::size_t inflight_count() const {
        std::scoped_lock lock(mu_);
        return inflight_.size();
    }
    std::size_t launched_count() const {
        std::scoped_lock lock(mu_);
        return launched_count_;
    }
    std::size_t completed_count() const {
        std::scoped_lock lock(mu_);
        return completed_count_;
    }
    std::size_t total_scheduled_bytes() const {
        std::scoped_lock lock(mu_);
        std::size_t total = 0;
        for (const BucketState& bucket : buckets_) {
            total += bucket.info.bytes;
        }
        return total;
    }
    std::size_t max_scheduled_bucket_bytes() const {
        std::scoped_lock lock(mu_);
        std::size_t largest = 0;
        for (const BucketState& bucket : buckets_) {
            largest = std::max(largest, bucket.info.bytes);
        }
        return largest;
    }
    bool is_cancelled() const {
        std::scoped_lock lock(mu_);
        return cancelled_;
    }

private:
    struct ParamState {
        std::size_t bytes;
        std::size_t pending_contrib;
        std::uint64_t bucket_id;
        bool ready;
    };

    struct BucketState {
        BucketInfo info;
        bool sealed = false;
        bool launched = false;
        std::size_t pending_params = 0;
    };

    struct Inflight {
        Buffer buffer;
        std::uint64_t bucket_id;
    };

    struct Launch {
        std::uint64_t request_id;
        Buffer buffer;
        BucketInfo info;
    };

    struct Killed {
        std::uint64_t request_id;
        Buffer buffer;
        BucketInfo info;
    };

    BucketState& placeInBucket(std::size_t bytes);
    std::vector<Launch> pumpLocked();
    void fire(const std::vector<Launch>& pending);

    SchedulerConfig config_;
    AllreduceLauncher launcher_;
    AllreduceAbort abort_;
    std::shared_ptr<IBufferAllocator> allocator_;
    mutable std::mutex mu_;
    std::unordered_map<std::uint64_t, ParamState> params_;
    std::vector<BucketState> buckets_;
    std::unordered_map<std::uint64_t, Inflight> inflight_;
    std::int64_t open_index_ = -1;
    std::uint64_t next_request_id_ = 1;
    std::size_t launched_count_ = 0;
    std::size_t completed_count_ = 0;
    bool cancelled_ = false;
};

inline GradientBucketScheduler::BucketState&
GradientBucketScheduler::placeInBucket(std::size_t bytes) {
    if (bytes > config_.bucket_capacity_bytes) {
        if (open_index_ >= 0) {
            buckets_[static_cast<std::size_t>(open_index_)].sealed = true;
            open_index_ = -1;
        }
        BucketState exclusive;
        exclusive.info.bucket_id =
            static_cast<std::uint64_t>(buckets_.size());
        exclusive.sealed = true;  // 超限参数独占，不允许后续参数追加。
        buckets_.push_back(std::move(exclusive));
        return buckets_.back();
    }
    if (open_index_ >= 0) {
        BucketState& open = buckets_[static_cast<std::size_t>(open_index_)];
        if (open.info.bytes + bytes <= config_.bucket_capacity_bytes) {
            return open;
        }
        open.sealed = true;
        open_index_ = -1;
    }
    BucketState bucket;
    bucket.info.bucket_id = static_cast<std::uint64_t>(buckets_.size());
    buckets_.push_back(std::move(bucket));
    open_index_ = static_cast<std::int64_t>(buckets_.size()) - 1;
    return buckets_.back();
}

// 仅在 mu_ 持有下调用：按桶 id 顺序发射所有“已封闭、参数全部就绪、
// 在途窗口未满”的桶。窗口满即停，后续由 complete() 再次驱动。
inline std::vector<GradientBucketScheduler::Launch>
GradientBucketScheduler::pumpLocked() {
    std::vector<Launch> ready;
    if (cancelled_) {
        return ready;
    }
    for (BucketState& bucket : buckets_) {
        if (bucket.launched || !bucket.sealed || bucket.pending_params != 0) {
            continue;
        }
        if (inflight_.size() >= config_.max_inflight_buckets) {
            break;
        }
        Buffer buffer = Buffer::create(*allocator_, bucket.info.bytes);
        const std::uint64_t request_id = next_request_id_++;
        inflight_.emplace(request_id,
                          Inflight{buffer, bucket.info.bucket_id});
        bucket.launched = true;
        ++launched_count_;
        ready.push_back(Launch{request_id, buffer, bucket.info});
    }
    return ready;
}

inline void GradientBucketScheduler::fire(
    const std::vector<GradientBucketScheduler::Launch>& pending) {
    for (const Launch& item : pending) {
        launcher_(item.request_id, item.buffer, item.info);
    }
}

inline void GradientBucketScheduler::register_tensor(
    std::uint64_t param_id, std::size_t bytes) {
    if (bytes == 0) {
        throw std::invalid_argument("tensor bytes must be non-zero");
    }
    std::vector<Launch> pending;
    {
        std::scoped_lock lock(mu_);
        if (cancelled_) {
            throw std::logic_error("register_tensor called after cancel");
        }
        auto it = params_.find(param_id);
        if (it == params_.end()) {
            BucketState& bucket = placeInBucket(bytes);
            bucket.info.bytes += bytes;
            bucket.info.param_ids.push_back(param_id);
            ++bucket.pending_params;
            params_.emplace(param_id,
                            ParamState{bytes, 1, bucket.info.bucket_id, false});
            if (bucket.info.bytes == config_.bucket_capacity_bytes) {
                bucket.sealed = true;
                open_index_ = -1;
            }
        } else {
            ++it->second.pending_contrib;
        }
        pending = pumpLocked();
    }
    fire(pending);
}

inline void GradientBucketScheduler::seal() {
    std::scoped_lock lock(mu_);
    if (open_index_ >= 0) {
        buckets_[static_cast<std::size_t>(open_index_)].sealed = true;
        open_index_ = -1;
    }
}

inline void GradientBucketScheduler::flush() {
    std::vector<Launch> pending;
    {
        std::scoped_lock lock(mu_);
        if (open_index_ >= 0) {
            buckets_[static_cast<std::size_t>(open_index_)].sealed = true;
            open_index_ = -1;
        }
        if (!cancelled_) {
            pending = pumpLocked();
        }
    }
    fire(pending);
}

inline void GradientBucketScheduler::mark_ready(std::uint64_t param_id) {
    std::vector<Launch> pending;
    {
        std::scoped_lock lock(mu_);
        if (cancelled_) {
            return;
        }
        auto it = params_.find(param_id);
        if (it == params_.end()) {
            throw std::invalid_argument("mark_ready for unknown param_id");
        }
        ParamState& state = it->second;
        if (state.pending_contrib == 0) {
            throw std::logic_error(
                "gradient marked ready more times than registered");
        }
        if (--state.pending_contrib == 0) {
            state.ready = true;
            BucketState& bucket = buckets_[state.bucket_id];
            if (bucket.pending_params == 0) {
                throw std::logic_error("bucket readiness counter underflow");
            }
            --bucket.pending_params;
        }
        pending = pumpLocked();
    }
    fire(pending);
}

inline bool GradientBucketScheduler::complete(std::uint64_t request_id) {
    Buffer dropped;
    std::vector<Launch> pending;
    {
        std::scoped_lock lock(mu_);
        auto it = inflight_.find(request_id);
        if (it == inflight_.end()) {
            return false;
        }
        dropped = std::move(it->second.buffer);
        inflight_.erase(it);
        ++completed_count_;
        pending = pumpLocked();
    }
    dropped.reset();  // 锁外回收，避免分配器回调持锁。
    fire(pending);
    return true;
}

inline void GradientBucketScheduler::cancel() {
    std::vector<Killed> killed;
    AllreduceAbort abort;
    {
        std::scoped_lock lock(mu_);
        if (cancelled_) {
            return;
        }
        cancelled_ = true;
        killed.reserve(inflight_.size());
        for (auto& [request_id, inflight] : inflight_) {
            killed.push_back(Killed{
                request_id, inflight.buffer,
                buckets_[inflight.bucket_id].info});
        }
        inflight_.clear();
        abort = abort_;
    }
    if (abort) {
        for (const Killed& item : killed) {
            abort(item.request_id, item.info);
        }
    }
    for (Killed& item : killed) {
        item.buffer.reset();
    }
}

}  // namespace dlks::formal
