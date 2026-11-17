#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dlks {

using NodeId = std::uint32_t;

namespace detail {

class ThreadCache;

}  // namespace detail

enum class PageState : std::uint8_t {
    free,
    cached,
    allocated,
    recycling,
};

class NumaTopology {
public:
    struct NodeSpec {
        std::size_t page_count{};
        std::uint32_t latency_ns{};
    };

    NumaTopology() = delete;

    explicit NumaTopology(
        std::vector<NodeSpec> nodes,
        std::vector<std::vector<std::uint32_t>> latency_ns = {});

    static NumaTopology uniform(
        std::size_t node_count,
        std::size_t pages_per_node,
        std::uint32_t local_latency_ns = 80,
        std::uint32_t remote_latency_ns = 180);

    static NumaTopology from_page_counts(
        std::vector<std::size_t> pages_per_node,
        std::uint32_t local_latency_ns = 80,
        std::uint32_t remote_latency_ns = 180);

    [[nodiscard]] std::size_t node_count() const noexcept { return nodes_.size(); }
    [[nodiscard]] std::size_t total_pages() const noexcept { return total_pages_; }
    [[nodiscard]] std::size_t page_count(NodeId node) const;
    [[nodiscard]] std::uint32_t latency(NodeId from, NodeId to) const;
    [[nodiscard]] const std::vector<NodeId>& nodes_by_latency(NodeId from) const;
    [[nodiscard]] const std::vector<NodeSpec>& nodes() const noexcept { return nodes_; }

private:
    std::vector<NodeSpec> nodes_;
    std::vector<std::vector<std::uint32_t>> latency_;
    std::vector<std::vector<NodeId>> borrow_order_;
    std::size_t total_pages_{};

    void build_borrow_order();
};

struct NumaPoolConfig {
    std::size_t page_size{4096};

    // Refill at most this many pages from the preferred node in one go.
    std::size_t local_batch{2};
    // Upper bound for the number of free local pages retained by one cache.
    std::size_t local_cache_limit{8};

    // Once this many foreign pages are owned by a cache, free foreign pages
    // are handed back to their home node one batch at a time.
    std::size_t borrow_threshold{4};
    std::size_t return_batch{1};

    // Hard per-cache bound, including foreign pages currently allocated.
    std::size_t max_remote_pages{8};
};

struct Page {
    Page(const Page&) = delete;
    Page& operator=(const Page&) = delete;

    [[nodiscard]] std::byte* data() noexcept { return data_; }
    [[nodiscard]] const std::byte* data() const noexcept { return data_; }
    [[nodiscard]] std::size_t size() const noexcept { return size_; }
    [[nodiscard]] NodeId home_node() const noexcept { return home_node_; }
    [[nodiscard]] std::uint32_t index() const noexcept { return index_; }
    [[nodiscard]] PageState state() const noexcept {
        return state_.load(std::memory_order_acquire);
    }

private:
    friend class NumaPagePool;
    friend class detail::ThreadCache;

    Page(std::byte* data, std::size_t size, NodeId home, std::uint32_t index) noexcept
        : data_(data), size_(size), home_node_(home), index_(index) {}

    std::byte* data_;
    std::size_t size_;
    NodeId home_node_;
    std::uint32_t index_;
    std::atomic<PageState> state_{PageState::free};
    std::atomic<std::uint64_t> owner_cache_{0};
    std::atomic<bool> borrowed_{false};
};

struct NumaPoolStatistics {
    std::size_t page_size{};
    std::size_t total_pages{};
    std::vector<std::size_t> page_budget_by_node;
    std::vector<std::size_t> central_free_by_node;
    std::size_t central_free_pages{};
    std::size_t cached_pages{};
    std::size_t allocated_pages{};
    std::size_t recycling_pages{};

    std::uint64_t local_allocations{};
    std::uint64_t remote_allocations{};
    std::uint64_t remote_borrows{};
    std::uint64_t progressive_returns{};
    std::uint64_t progressive_return_events{};
    std::size_t remote_pages_live{};
    std::size_t remote_peak_per_cache{};
    std::size_t max_remote_pages_per_cache{};
    std::size_t remote_cached_pages{};

    std::uint64_t double_free_rejections{};
    std::uint64_t invalid_release_rejections{};
    std::uint64_t budget_violations{};
    std::uint64_t cache_retirements{};
    std::size_t live_caches{};
};

struct NumaPoolAudit {
    bool ok{true};
    std::size_t duplicate_pages{};
    std::size_t unaccounted_pages{};
    std::size_t budget_mismatches{};
    std::size_t remote_bound_violations{};
    std::string message;

    explicit operator bool() const noexcept { return ok; }
};

class NumaPagePool {
public:
    struct Impl;

    explicit NumaPagePool(
        NumaTopology topology,
        NumaPoolConfig config = {});
    ~NumaPagePool();

    NumaPagePool(const NumaPagePool&) = delete;
    NumaPagePool& operator=(const NumaPagePool&) = delete;
    NumaPagePool(NumaPagePool&&) noexcept;
    NumaPagePool& operator=(NumaPagePool&&) noexcept;

    // Returns nullptr when the preferred node and allowed remote budget are
    // exhausted. The returned page is stable for the pool's lifetime.
    [[nodiscard]] Page* acquire_page(NodeId preferred_node = 0);
    void release_page(Page* page) noexcept;

    // Retires this thread's caches for this pool. The next acquire creates a
    // fresh cache. Safe to call more than once and concurrently with release.
    std::size_t reclaim_current_thread();

    // Retires every currently registered cache. Allocations may continue and
    // will establish new caches. Returns the number of cached pages returned.
    std::size_t reclaim_all_threads();

    [[nodiscard]] const NumaTopology& topology() const noexcept;
    [[nodiscard]] const NumaPoolConfig& config() const noexcept;
    [[nodiscard]] std::size_t page_size() const noexcept;

    [[nodiscard]] NumaPoolStatistics statistics() const;

    // Intended for quiescent checkpoints in tests and diagnostics. It walks
    // central free lists and live caches and detects duplicate ownership.
    [[nodiscard]] NumaPoolAudit audit() const;

private:
    std::shared_ptr<Impl> impl_;
};

struct NumaPagePool::Impl : std::enable_shared_from_this<NumaPagePool::Impl> {
    struct NodeFree {
        explicit NodeFree(std::size_t budget_in) : budget(budget_in) {
            pages.reserve(budget);
        }

        std::size_t budget;
        std::mutex mutex;
        std::vector<Page*> pages;
    };

    struct Arena {
        Arena(void* base_in, std::size_t alignment_in) noexcept
            : base(base_in), alignment(alignment_in) {}
        ~Arena() {
            if (base != nullptr) {
                ::operator delete(base, std::align_val_t(alignment));
            }
        }

        void* base;
        std::size_t alignment;
    };

    Impl(NumaTopology topology, NumaPoolConfig config);

    Page* take_free(NodeId node, std::size_t count, std::vector<Page*>& out);
    Page* take_one_free(NodeId node);
    void return_cached_page(Page* page) noexcept;
    void return_recycling_page(Page* page) noexcept;
    void note_borrow() noexcept;
    void note_remote_peak(std::size_t value) noexcept;
    void note_double_free() noexcept;
    void note_invalid_release() noexcept;
    void note_budget_violation() noexcept;

    std::shared_ptr<detail::ThreadCache> create_cache(NodeId preferred);
    std::shared_ptr<detail::ThreadCache> find_cache(std::uint64_t id) noexcept;
    std::size_t retire_all_caches(bool stop_pool) noexcept;
    std::size_t live_cache_count() const;

    [[nodiscard]] bool stopping() const noexcept {
        return stopping_.load(std::memory_order_acquire);
    }

    [[nodiscard]] bool owns(const Page* page) const noexcept {
        return by_page.find(page) != by_page.end();
    }

    NumaTopology topology;
    NumaPoolConfig config;
    std::vector<std::unique_ptr<Arena>> arenas;
    std::vector<std::unique_ptr<NodeFree>> nodes;
    std::vector<std::unique_ptr<Page>> pages;
    std::unordered_map<const Page*, std::size_t> by_page;

    mutable std::mutex caches_mutex;
    std::unordered_map<std::uint64_t, std::weak_ptr<detail::ThreadCache>> caches;
    std::uint64_t next_cache_id{1};
    std::atomic<bool> stopping_{false};

    std::atomic<std::uint64_t> local_allocations{0};
    std::atomic<std::uint64_t> remote_allocations{0};
    std::atomic<std::uint64_t> remote_borrows{0};
    std::atomic<std::uint64_t> progressive_returns{0};
    std::atomic<std::uint64_t> progressive_return_events{0};
    std::atomic<std::size_t> remote_pages_live{0};
    std::atomic<std::size_t> remote_peak_per_cache{0};
    std::atomic<std::uint64_t> double_free_rejections{0};
    std::atomic<std::uint64_t> invalid_release_rejections{0};
    std::atomic<std::uint64_t> budget_violations{0};
    std::atomic<std::uint64_t> cache_retirements{0};
};

namespace detail {

struct CacheSnapshot {
    std::vector<Page*> local;
    std::vector<Page*> remote;
    std::size_t remote_owned{};
    std::size_t remote_cached{};
};

class ThreadCache {
public:
    ThreadCache(
        std::shared_ptr<NumaPagePool::Impl> core_in,
        std::uint64_t id_in,
        NodeId preferred_in)
        : core_(std::move(core_in)), id_(id_in), preferred_(preferred_in) {
        local_.reserve(core_->config.local_cache_limit);
        remote_.reserve(core_->config.max_remote_pages);
    }

    ~ThreadCache() { (void)retire(); }

    ThreadCache(const ThreadCache&) = delete;
    ThreadCache& operator=(const ThreadCache&) = delete;

    [[nodiscard]] bool retired() const noexcept {
        return retired_.load(std::memory_order_acquire);
    }

    [[nodiscard]] bool belongs_to(const NumaPagePool::Impl* core) const noexcept {
        return core_.get() == core;
    }

    [[nodiscard]] NodeId preferred() const noexcept { return preferred_; }

    [[nodiscard]] CacheSnapshot snapshot() const {
        std::lock_guard<std::mutex> lock(mutex_);
        CacheSnapshot result;
        result.local = local_;
        result.remote = remote_;
        result.remote_owned = remote_owned_;
        result.remote_cached = remote_cached_;
        return result;
    }

    [[nodiscard]] Page* acquire() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (retired_.load(std::memory_order_relaxed) || core_->stopping()) {
            return nullptr;
        }

        Page* page = pop_cached();
        if (page == nullptr) {
            refill_local();
            page = pop_cached();
        }
        if (page == nullptr) {
            page = borrow_remote();
        }
        if (page == nullptr) {
            return nullptr;
        }

        page->owner_cache_.store(id_, std::memory_order_relaxed);
        page->state_.store(PageState::allocated, std::memory_order_release);

        if (page->home_node_ == preferred_) {
            core_->local_allocations.fetch_add(1, std::memory_order_relaxed);
        } else {
            core_->remote_allocations.fetch_add(1, std::memory_order_relaxed);
        }

        maintain_remote();
        return page;
    }

    // Called after the pool has claimed a page with allocated -> recycling.
    [[nodiscard]] bool release(Page* page) noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (retired_.load(std::memory_order_relaxed)) {
            return false;
        }

        if (page->home_node_ == preferred_) {
            if (local_.size() >= core_->config.local_cache_limit) {
                core_->return_recycling_page(page);
                return true;
            }
            local_.push_back(page);
        } else {
            remote_.push_back(page);
            ++remote_cached_;
        }

        page->state_.store(PageState::cached, std::memory_order_release);
        maintain_remote();
        return true;
    }

    [[nodiscard]] std::size_t retire() noexcept {
        std::vector<Page*> local_pages;
        std::vector<Page*> remote_pages;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (retired_.exchange(true, std::memory_order_acq_rel)) {
                return 0;
            }
            local_pages.swap(local_);
            remote_pages.swap(remote_);
            remote_cached_ = 0;
            remote_owned_ = 0;
        }

        const std::size_t count = local_pages.size() + remote_pages.size();
        for (Page* page : local_pages) {
            core_->return_cached_page(page);
        }
        for (Page* page : remote_pages) {
            core_->return_cached_page(page);
        }
        core_->cache_retirements.fetch_add(1, std::memory_order_relaxed);
        return count;
    }

private:
    [[nodiscard]] Page* pop_cached() noexcept {
        if (!local_.empty()) {
            Page* page = local_.back();
            local_.pop_back();
            return page;
        }
        if (!remote_.empty()) {
            Page* page = remote_.back();
            remote_.pop_back();
            --remote_cached_;
            return page;
        }
        return nullptr;
    }

    void refill_local() {
        if (local_.size() >= core_->config.local_cache_limit) {
            return;
        }
        const std::size_t room = core_->config.local_cache_limit - local_.size();
        const std::size_t wanted = std::min(core_->config.local_batch, room);
        if (wanted == 0) {
            return;
        }

        std::vector<Page*> fetched;
        fetched.reserve(wanted);
        core_->take_free(preferred_, wanted, fetched);
        for (Page* page : fetched) {
            page->owner_cache_.store(id_, std::memory_order_relaxed);
            page->borrowed_.store(false, std::memory_order_relaxed);
            local_.push_back(page);
        }
    }

    [[nodiscard]] Page* borrow_remote() {
        if (remote_owned_ >= core_->config.max_remote_pages) {
            return nullptr;
        }
        if (remote_owned_ >= core_->config.borrow_threshold) {
            maintain_remote();
            if (remote_owned_ >= core_->config.max_remote_pages) {
                return nullptr;
            }
        }

        const auto& order = core_->topology.nodes_by_latency(preferred_);
        for (NodeId node : order) {
            if (node == preferred_) {
                continue;
            }
            Page* page = core_->take_one_free(node);
            if (page == nullptr) {
                continue;
            }

            page->owner_cache_.store(id_, std::memory_order_relaxed);
            page->borrowed_.store(true, std::memory_order_relaxed);
            ++remote_owned_;
            core_->note_borrow();
            core_->note_remote_peak(remote_owned_);
            return page;
        }
        return nullptr;
    }

    void maintain_remote() noexcept {
        if (remote_owned_ < core_->config.borrow_threshold || remote_.empty()) {
            return;
        }

        std::size_t budget = core_->config.return_batch;
        bool returned_any = false;
        while (budget-- > 0 && remote_owned_ >= core_->config.borrow_threshold &&
               !remote_.empty()) {
            Page* page = remote_.back();
            remote_.pop_back();
            --remote_cached_;
            --remote_owned_;
            core_->return_cached_page(page);
            returned_any = true;
        }
        if (returned_any) {
            core_->progressive_return_events.fetch_add(1, std::memory_order_relaxed);
        }
    }

    std::shared_ptr<NumaPagePool::Impl> core_;
    const std::uint64_t id_;
    const NodeId preferred_;
    mutable std::mutex mutex_;
    std::atomic<bool> retired_{false};
    std::vector<Page*> local_;
    std::vector<Page*> remote_;
    std::size_t remote_cached_{};
    std::size_t remote_owned_{};
};

inline thread_local std::vector<std::shared_ptr<ThreadCache>> thread_cache_slots;

inline std::shared_ptr<ThreadCache> cache_for(
    const std::shared_ptr<NumaPagePool::Impl>& core,
    NodeId preferred) {
    for (auto it = thread_cache_slots.begin(); it != thread_cache_slots.end();) {
        const auto& cache = *it;
        if (!cache || cache->retired()) {
            it = thread_cache_slots.erase(it);
            continue;
        }
        ++it;
    }

    for (const auto& cache : thread_cache_slots) {
        if (cache->belongs_to(core.get()) && cache->preferred() == preferred) {
            return cache;
        }
    }

    std::shared_ptr<ThreadCache> cache = core->create_cache(preferred);
    if (cache) {
        thread_cache_slots.push_back(cache);
    }
    return cache;
}

}  // namespace detail

inline NumaTopology::NumaTopology(
    std::vector<NodeSpec> nodes,
    std::vector<std::vector<std::uint32_t>> latency_ns)
    : nodes_(std::move(nodes)), latency_(std::move(latency_ns)) {
    if (nodes_.empty()) {
        throw std::invalid_argument("NumaTopology requires at least one node");
    }
    if (nodes_.size() > static_cast<std::size_t>(std::numeric_limits<NodeId>::max())) {
        throw std::invalid_argument("NumaTopology has too many nodes");
    }

    for (const NodeSpec& node : nodes_) {
        if (node.page_count == 0) {
            throw std::invalid_argument("each NUMA node needs at least one page");
        }
        if (node.page_count >
            std::numeric_limits<std::size_t>::max() - total_pages_) {
            throw std::overflow_error("NUMA page budget overflows size_t");
        }
        total_pages_ += node.page_count;
    }
    if (total_pages_ > static_cast<std::size_t>(std::numeric_limits<std::uint32_t>::max())) {
        throw std::invalid_argument("page index space exceeds uint32_t");
    }

    if (latency_.empty()) {
        latency_.resize(nodes_.size());
        for (std::size_t from = 0; from < nodes_.size(); ++from) {
            latency_[from].resize(nodes_.size());
            for (std::size_t to = 0; to < nodes_.size(); ++to) {
                if (from == to) {
                    latency_[from][to] = nodes_[from].latency_ns;
                } else {
                    const std::uint64_t sum =
                        static_cast<std::uint64_t>(nodes_[from].latency_ns) +
                        static_cast<std::uint64_t>(nodes_[to].latency_ns);
                    latency_[from][to] = static_cast<std::uint32_t>(
                        std::min<std::uint64_t>(
                            sum, std::numeric_limits<std::uint32_t>::max()));
                }
            }
        }
    } else {
        if (latency_.size() != nodes_.size()) {
            throw std::invalid_argument("NUMA latency matrix must match node count");
        }
        for (const auto& row : latency_) {
            if (row.size() != nodes_.size()) {
                throw std::invalid_argument("NUMA latency matrix must be square");
            }
        }
    }

    build_borrow_order();
}

inline NumaTopology NumaTopology::uniform(
    std::size_t node_count,
    std::size_t pages_per_node,
    std::uint32_t local_latency_ns,
    std::uint32_t remote_latency_ns) {
    std::vector<NodeSpec> nodes;
    nodes.reserve(node_count);
    for (std::size_t i = 0; i < node_count; ++i) {
        nodes.push_back(NodeSpec{pages_per_node, local_latency_ns});
    }

    std::vector<std::vector<std::uint32_t>> latency(
        node_count, std::vector<std::uint32_t>(node_count, remote_latency_ns));
    for (std::size_t i = 0; i < node_count; ++i) {
        latency[i][i] = local_latency_ns;
    }
    return NumaTopology(std::move(nodes), std::move(latency));
}

inline NumaTopology NumaTopology::from_page_counts(
    std::vector<std::size_t> pages_per_node,
    std::uint32_t local_latency_ns,
    std::uint32_t remote_latency_ns) {
    if (pages_per_node.empty()) {
        throw std::invalid_argument("NumaTopology requires at least one node");
    }
    std::vector<NodeSpec> nodes;
    nodes.reserve(pages_per_node.size());
    for (std::size_t pages : pages_per_node) {
        nodes.push_back(NodeSpec{pages, local_latency_ns});
    }

    const std::size_t count = nodes.size();
    std::vector<std::vector<std::uint32_t>> latency(
        count, std::vector<std::uint32_t>(count, remote_latency_ns));
    for (std::size_t i = 0; i < count; ++i) {
        latency[i][i] = local_latency_ns;
    }
    return NumaTopology(std::move(nodes), std::move(latency));
}

inline std::size_t NumaTopology::page_count(NodeId node) const {
    if (node >= nodes_.size()) {
        throw std::out_of_range("NUMA node id out of range");
    }
    return nodes_[node].page_count;
}

inline std::uint32_t NumaTopology::latency(NodeId from, NodeId to) const {
    if (from >= nodes_.size() || to >= nodes_.size()) {
        throw std::out_of_range("NUMA node id out of range");
    }
    return latency_[from][to];
}

inline const std::vector<NodeId>& NumaTopology::nodes_by_latency(NodeId from) const {
    if (from >= nodes_.size()) {
        throw std::out_of_range("NUMA node id out of range");
    }
    return borrow_order_[from];
}

inline void NumaTopology::build_borrow_order() {
    borrow_order_.resize(nodes_.size());
    for (NodeId from = 0; from < nodes_.size(); ++from) {
        std::vector<NodeId>& order = borrow_order_[from];
        order.reserve(nodes_.size() - 1);
        for (NodeId to = 0; to < nodes_.size(); ++to) {
            if (to != from) {
                order.push_back(to);
            }
        }
        std::sort(order.begin(), order.end(), [&](NodeId lhs, NodeId rhs) {
            const std::uint32_t left = latency_[from][lhs];
            const std::uint32_t right = latency_[from][rhs];
            return left == right ? lhs < rhs : left < right;
        });
    }
}

inline NumaPagePool::Impl::Impl(NumaTopology topology_in, NumaPoolConfig config_in)
    : topology(std::move(topology_in)), config(config_in) {
    if (config.page_size < alignof(std::max_align_t) ||
        (config.page_size & (config.page_size - 1)) != 0) {
        throw std::invalid_argument(
            "page_size must be a power of two and at least max_align_t");
    }
    if (config.local_batch == 0 || config.local_cache_limit == 0) {
        throw std::invalid_argument("local batches and cache limits must be non-zero");
    }
    if (config.borrow_threshold == 0 || config.return_batch == 0) {
        throw std::invalid_argument("borrow threshold and return batch must be non-zero");
    }
    if (config.max_remote_pages < config.borrow_threshold) {
        throw std::invalid_argument(
            "max_remote_pages must be at least borrow_threshold");
    }

    nodes.reserve(topology.node_count());
    pages.reserve(topology.total_pages());
    by_page.reserve(topology.total_pages() * 2);
    arenas.reserve(topology.node_count());

    std::uint32_t next_index = 0;
    for (NodeId node = 0; node < topology.node_count(); ++node) {
        const std::size_t count = topology.page_count(node);
        if (count > std::numeric_limits<std::size_t>::max() / config.page_size) {
            throw std::overflow_error("NUMA node arena size overflows size_t");
        }
        const std::size_t bytes = count * config.page_size;
        void* base = ::operator new(bytes, std::align_val_t(config.page_size));
        arenas.push_back(std::make_unique<Arena>(base, config.page_size));

        auto node_free = std::make_unique<NodeFree>(count);
        auto* node_data = static_cast<std::byte*>(base);
        for (std::size_t i = 0; i < count; ++i) {
            auto page = std::unique_ptr<Page>(new Page(
                node_data + i * config.page_size,
                config.page_size,
                node,
                next_index));
            by_page.emplace(page.get(), static_cast<std::size_t>(next_index));
            node_free->pages.push_back(page.get());
            pages.push_back(std::move(page));
            ++next_index;
        }
        nodes.push_back(std::move(node_free));
    }
}

inline Page* NumaPagePool::Impl::take_free(
    NodeId node,
    std::size_t count,
    std::vector<Page*>& out) {
    NodeFree& pool = *nodes[node];
    std::lock_guard<std::mutex> lock(pool.mutex);
    Page* first = nullptr;
    while (count-- > 0 && !pool.pages.empty()) {
        Page* page = pool.pages.back();
        pool.pages.pop_back();
        PageState expected = PageState::free;
        if (!page->state_.compare_exchange_strong(
                expected, PageState::cached, std::memory_order_acq_rel)) {
            note_budget_violation();
            continue;
        }
        out.push_back(page);
        if (first == nullptr) {
            first = page;
        }
    }
    return first;
}

inline Page* NumaPagePool::Impl::take_one_free(NodeId node) {
    NodeFree& pool = *nodes[node];
    std::lock_guard<std::mutex> lock(pool.mutex);
    while (!pool.pages.empty()) {
        Page* page = pool.pages.back();
        pool.pages.pop_back();
        PageState expected = PageState::free;
        if (!page->state_.compare_exchange_strong(
                expected, PageState::cached, std::memory_order_acq_rel)) {
            note_budget_violation();
            continue;
        }
        return page;
    }
    return nullptr;
}

inline void NumaPagePool::Impl::return_cached_page(Page* page) noexcept {
    NodeId node = page->home_node_;
    NodeFree& pool = *nodes[node];
    bool was_borrowed = false;
    {
        std::lock_guard<std::mutex> lock(pool.mutex);
        was_borrowed = page->borrowed_.exchange(false, std::memory_order_acq_rel);
        if (was_borrowed) {
            remote_pages_live.fetch_sub(1, std::memory_order_relaxed);
            progressive_returns.fetch_add(1, std::memory_order_relaxed);
        }
        page->state_.store(PageState::free, std::memory_order_release);
        pool.pages.push_back(page);
    }
}

inline void NumaPagePool::Impl::return_recycling_page(Page* page) noexcept {
    NodeId node = page->home_node_;
    NodeFree& pool = *nodes[node];
    {
        std::lock_guard<std::mutex> lock(pool.mutex);
        if (page->borrowed_.exchange(false, std::memory_order_acq_rel)) {
            remote_pages_live.fetch_sub(1, std::memory_order_relaxed);
        }
        page->state_.store(PageState::free, std::memory_order_release);
        pool.pages.push_back(page);
    }
}

inline void NumaPagePool::Impl::note_borrow() noexcept {
    remote_borrows.fetch_add(1, std::memory_order_relaxed);
    remote_pages_live.fetch_add(1, std::memory_order_relaxed);
}

inline void NumaPagePool::Impl::note_remote_peak(std::size_t value) noexcept {
    std::size_t current = remote_peak_per_cache.load(std::memory_order_relaxed);
    while (current < value &&
           !remote_peak_per_cache.compare_exchange_weak(
               current, value, std::memory_order_relaxed)) {
    }
}

inline void NumaPagePool::Impl::note_double_free() noexcept {
    double_free_rejections.fetch_add(1, std::memory_order_relaxed);
}

inline void NumaPagePool::Impl::note_invalid_release() noexcept {
    invalid_release_rejections.fetch_add(1, std::memory_order_relaxed);
}

inline void NumaPagePool::Impl::note_budget_violation() noexcept {
    budget_violations.fetch_add(1, std::memory_order_relaxed);
}

inline std::shared_ptr<detail::ThreadCache> NumaPagePool::Impl::create_cache(
    NodeId preferred) {
    std::lock_guard<std::mutex> lock(caches_mutex);
    if (stopping_.load(std::memory_order_acquire)) {
        return nullptr;
    }
    const std::uint64_t id = next_cache_id++;
    auto cache = std::make_shared<detail::ThreadCache>(shared_from_this(), id, preferred);
    caches.emplace(id, cache);
    return cache;
}

inline std::shared_ptr<detail::ThreadCache> NumaPagePool::Impl::find_cache(
    std::uint64_t id) noexcept {
    std::lock_guard<std::mutex> lock(caches_mutex);
    auto it = caches.find(id);
    if (it == caches.end()) {
        return {};
    }
    return it->second.lock();
}

inline std::size_t NumaPagePool::Impl::retire_all_caches(bool stop_pool) noexcept {
    std::vector<std::shared_ptr<detail::ThreadCache>> live;
    {
        std::lock_guard<std::mutex> lock(caches_mutex);
        if (stop_pool) {
            stopping_.store(true, std::memory_order_release);
        }
        live.reserve(caches.size());
        for (auto& entry : caches) {
            if (auto cache = entry.second.lock()) {
                live.push_back(std::move(cache));
            }
        }
        caches.clear();
    }

    std::size_t pages = 0;
    for (const auto& cache : live) {
        pages += cache->retire();
    }
    return pages;
}

inline std::size_t NumaPagePool::Impl::live_cache_count() const {
    std::lock_guard<std::mutex> lock(caches_mutex);
    std::size_t result = 0;
    for (const auto& entry : caches) {
        if (!entry.second.expired()) {
            ++result;
        }
    }
    return result;
}

inline NumaPagePool::NumaPagePool(
    NumaTopology topology,
    NumaPoolConfig config)
    : impl_(std::make_shared<Impl>(std::move(topology), config)) {}

inline NumaPagePool::~NumaPagePool() {
    if (impl_) {
        impl_->retire_all_caches(true);
    }
}

inline NumaPagePool::NumaPagePool(NumaPagePool&& other) noexcept
    : impl_(std::move(other.impl_)) {}

inline NumaPagePool& NumaPagePool::operator=(NumaPagePool&& other) noexcept {
    if (this != &other) {
        if (impl_) {
            impl_->retire_all_caches(true);
        }
        impl_ = std::move(other.impl_);
    }
    return *this;
}

inline Page* NumaPagePool::acquire_page(NodeId preferred_node) {
    if (!impl_ || preferred_node >= impl_->topology.node_count()) {
        throw std::out_of_range("preferred NUMA node id out of range");
    }
    auto cache = detail::cache_for(impl_, preferred_node);
    return cache ? cache->acquire() : nullptr;
}

inline void NumaPagePool::release_page(Page* page) noexcept {
    if (!impl_ || page == nullptr) {
        if (impl_) {
            impl_->note_invalid_release();
        }
        return;
    }
    if (!impl_->owns(page)) {
        impl_->note_invalid_release();
        return;
    }

    PageState expected = PageState::allocated;
    if (!page->state_.compare_exchange_strong(
            expected, PageState::recycling, std::memory_order_acq_rel)) {
        impl_->note_double_free();
        return;
    }

    const std::uint64_t owner = page->owner_cache_.load(std::memory_order_relaxed);
    auto cache = impl_->find_cache(owner);
    if (cache && cache->release(page)) {
        return;
    }
    impl_->return_recycling_page(page);
}

inline std::size_t NumaPagePool::reclaim_current_thread() {
    if (!impl_) {
        return 0;
    }

    std::size_t pages = 0;
    auto& slots = detail::thread_cache_slots;
    for (auto it = slots.begin(); it != slots.end();) {
        const auto& cache = *it;
        if (!cache) {
            it = slots.erase(it);
            continue;
        }
        if (cache->belongs_to(impl_.get())) {
            pages += cache->retire();
            it = slots.erase(it);
        } else {
            ++it;
        }
    }
    return pages;
}

inline std::size_t NumaPagePool::reclaim_all_threads() {
    return impl_ ? impl_->retire_all_caches(false) : 0;
}

inline const NumaTopology& NumaPagePool::topology() const noexcept {
    return impl_->topology;
}

inline const NumaPoolConfig& NumaPagePool::config() const noexcept {
    return impl_->config;
}

inline std::size_t NumaPagePool::page_size() const noexcept {
    return impl_->config.page_size;
}

inline NumaPoolStatistics NumaPagePool::statistics() const {
    NumaPoolStatistics stats;
    if (!impl_) {
        return stats;
    }

    stats.page_size = impl_->config.page_size;
    stats.total_pages = impl_->pages.size();
    stats.page_budget_by_node.resize(impl_->topology.node_count());
    stats.central_free_by_node.resize(impl_->topology.node_count());
    for (NodeId node = 0; node < impl_->topology.node_count(); ++node) {
        stats.page_budget_by_node[node] = impl_->nodes[node]->budget;
    }

    for (const auto& page : impl_->pages) {
        const PageState state = page->state();
        switch (state) {
            case PageState::free:
                ++stats.central_free_pages;
                ++stats.central_free_by_node[page->home_node_];
                break;
            case PageState::cached:
                ++stats.cached_pages;
                if (page->borrowed_.load(std::memory_order_relaxed)) {
                    ++stats.remote_cached_pages;
                }
                break;
            case PageState::allocated:
                ++stats.allocated_pages;
                break;
            case PageState::recycling:
                ++stats.recycling_pages;
                break;
        }
    }

    stats.local_allocations =
        impl_->local_allocations.load(std::memory_order_relaxed);
    stats.remote_allocations =
        impl_->remote_allocations.load(std::memory_order_relaxed);
    stats.remote_borrows = impl_->remote_borrows.load(std::memory_order_relaxed);
    stats.progressive_returns =
        impl_->progressive_returns.load(std::memory_order_relaxed);
    stats.progressive_return_events =
        impl_->progressive_return_events.load(std::memory_order_relaxed);
    stats.remote_pages_live =
        impl_->remote_pages_live.load(std::memory_order_relaxed);
    stats.remote_peak_per_cache =
        impl_->remote_peak_per_cache.load(std::memory_order_relaxed);
    stats.max_remote_pages_per_cache = impl_->config.max_remote_pages;
    stats.double_free_rejections =
        impl_->double_free_rejections.load(std::memory_order_relaxed);
    stats.invalid_release_rejections =
        impl_->invalid_release_rejections.load(std::memory_order_relaxed);
    stats.budget_violations =
        impl_->budget_violations.load(std::memory_order_relaxed);
    stats.cache_retirements =
        impl_->cache_retirements.load(std::memory_order_relaxed);
    stats.live_caches = impl_->live_cache_count();
    return stats;
}

inline NumaPoolAudit NumaPagePool::audit() const {
    NumaPoolAudit result;
    if (!impl_) {
        result.ok = false;
        result.message = "pool has no implementation";
        return result;
    }

    std::vector<const Page*> seen;
    seen.reserve(impl_->pages.size());
    std::vector<std::size_t> free_by_node(impl_->topology.node_count(), 0);

    for (NodeId node = 0; node < impl_->topology.node_count(); ++node) {
        auto& pool = *impl_->nodes[node];
        std::vector<Page*> snapshot;
        {
            std::lock_guard<std::mutex> lock(pool.mutex);
            snapshot = pool.pages;
        }
        for (const Page* page : snapshot) {
            if (page->home_node_ != node) {
                ++result.budget_mismatches;
            }
            if (page->state() != PageState::free) {
                ++result.budget_mismatches;
            }
            seen.push_back(page);
        }
        free_by_node[node] = snapshot.size();
    }

    std::vector<std::shared_ptr<detail::ThreadCache>> caches;
    {
        std::lock_guard<std::mutex> lock(impl_->caches_mutex);
        caches.reserve(impl_->caches.size());
        for (const auto& entry : impl_->caches) {
            if (auto cache = entry.second.lock()) {
                caches.push_back(std::move(cache));
            }
        }
    }
    for (const auto& cache : caches) {
        detail::CacheSnapshot snapshot = cache->snapshot();
        if (snapshot.remote_owned > impl_->config.max_remote_pages) {
            ++result.remote_bound_violations;
        }
        if (snapshot.local.size() + snapshot.remote.size() >
            impl_->config.local_cache_limit + impl_->config.max_remote_pages) {
            ++result.remote_bound_violations;
        }
        seen.insert(seen.end(), snapshot.local.begin(), snapshot.local.end());
        seen.insert(seen.end(), snapshot.remote.begin(), snapshot.remote.end());
    }

    std::sort(seen.begin(), seen.end());
    for (std::size_t i = 1; i < seen.size(); ++i) {
        if (seen[i] == seen[i - 1]) {
            ++result.duplicate_pages;
        }
    }

    std::size_t accounted = 0;
    for (const auto& page : impl_->pages) {
        const bool is_listed =
            std::binary_search(seen.begin(), seen.end(), page.get());
        switch (page->state()) {
            case PageState::free:
            case PageState::cached:
                ++accounted;
                if (!is_listed) {
                    ++result.unaccounted_pages;
                }
                break;
            case PageState::allocated:
            case PageState::recycling:
                ++accounted;
                break;
        }
    }

    std::size_t budget_sum = 0;
    for (NodeId node = 0; node < impl_->topology.node_count(); ++node) {
        budget_sum += impl_->nodes[node]->budget;
        const std::size_t free_count = free_by_node[node];
        if (free_count > impl_->nodes[node]->budget) {
            ++result.budget_mismatches;
        }
    }
    if (budget_sum != impl_->pages.size() || accounted != impl_->pages.size()) {
        ++result.budget_mismatches;
    }

    result.ok = result.duplicate_pages == 0 &&
                result.unaccounted_pages == 0 &&
                result.budget_mismatches == 0 &&
                result.remote_bound_violations == 0;
    if (!result.ok) {
        result.message = "ownership audit failed";
    }
    return result;
}

}  // namespace dlks
