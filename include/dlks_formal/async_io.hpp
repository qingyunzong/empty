#pragma once

// 可嵌入的 C++20 异步 I/O 运行时组件。
//
// 设计要点:
//   * 固定容量槽位表,每个槽位携带单调递增的代次(generation)。
//   * 句柄 = (槽位下标, 代次)。槽位在终态迁移时立即回收并递增代次,
//     因此旧句柄上的迟到完成/取消/超时永远不会命中复用后的新请求。
//   * 终态迁移(完成/取消/超时)把回调移动进就绪队列,回调恰好被
//     run() 调用一次;同一句柄上的后续事件因代次失配被忽略。
//   * 析构前自动 drain():所有未决请求以 cancelled 终态收尾,
//     全部回调在对象销毁前排空,杜绝悬挂访问。
//   * 单线程确定性调度:相同事件序列产生相同的终态与回调顺序,
//     便于用确定性事件排列做穷尽验证。
//
// 约束:回调不得抛出异常;回调内允许 submit/cancel/complete,
// 不允许重入 run()(重入调用返回 0,外层循环继续排空)。

#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
#include <optional>
#include <queue>
#include <stdexcept>
#include <tuple>
#include <utility>
#include <vector>

namespace dlks_formal {

enum class io_status : std::uint8_t {
  completed,
  cancelled,
  timed_out,
};

struct io_result {
  io_status status = io_status::completed;
  std::uint64_t value = 0;  // 完成时携带的字节数/操作特定结果
};

using io_callback = std::function<void(io_result)>;

class io_handle {
public:
  io_handle() = default;

  explicit operator bool() const noexcept { return slot_ != invalid_slot; }

  friend bool operator==(io_handle, io_handle) = default;

private:
  friend class async_io_runtime;

  static constexpr std::uint32_t invalid_slot =
      std::numeric_limits<std::uint32_t>::max();

  io_handle(std::uint32_t slot, std::uint64_t generation) noexcept
      : slot_(slot), generation_(generation) {}

  std::uint32_t slot_ = invalid_slot;
  std::uint64_t generation_ = 0;
};

class async_io_runtime {
public:
  explicit async_io_runtime(std::size_t capacity) : slots_(capacity) {
    free_slots_.reserve(capacity);
    for (std::size_t i = capacity; i-- > 0;)
      free_slots_.push_back(static_cast<std::uint32_t>(i));
  }

  // 销毁前排空:未决请求以 cancelled 收尾,就绪回调全部调用完毕。
  ~async_io_runtime() { drain(); }

  async_io_runtime(const async_io_runtime&) = delete;
  async_io_runtime& operator=(const async_io_runtime&) = delete;
  async_io_runtime(async_io_runtime&&) = delete;
  async_io_runtime& operator=(async_io_runtime&&) = delete;

  // 提交无超时的请求。容量耗尽时抛出 std::length_error。
  [[nodiscard]] io_handle submit(io_callback callback) {
    return submit_impl(std::move(callback), std::nullopt);
  }

  // 提交带逻辑时钟截止时间的请求。
  [[nodiscard]] io_handle submit(io_callback callback,
                                 std::uint64_t deadline) {
    return submit_impl(std::move(callback), deadline);
  }

  // 取消未决请求;句柄失效(已完成/已取消/代次过期)时返回 false。
  bool cancel(io_handle handle) {
    if (!resolve(handle)) return false;
    finish(handle.slot_, io_result{io_status::cancelled, 0});
    return true;
  }

  // 外部事件源投递完成;乱序/迟到完成落在已复用槽位上时
  // 因代次失配返回 false,不会唤醒新请求。
  bool complete(io_handle handle, std::uint64_t value = 0) {
    if (!resolve(handle)) return false;
    finish(handle.slot_, io_result{io_status::completed, value});
    return true;
  }

  // 推进逻辑时钟并收割所有到期请求(超时与完成的竞争由
  // 事件到达顺序决定,先到者赢得终态)。
  void advance_clock(std::uint64_t now) {
    if (now > clock_) clock_ = now;
    while (!timers_.empty() && std::get<0>(timers_.top()) <= clock_) {
      const timer_key key = timers_.top();
      timers_.pop();
      const auto [deadline, index, generation] = key;
      slot_state& slot = slots_[index];
      if (!slot.occupied || slot.generation != generation) continue;
      finish(index, io_result{io_status::timed_out, 0});
    }
  }

  // 排空就绪队列,返回本次调用的回调数量。回调内重入返回 0。
  std::size_t run() {
    if (running_) return 0;
    running_ = true;
    struct guard {
      bool& flag;
      ~guard() { flag = false; }
    } reset{running_};

    std::size_t invoked = 0;
    while (!ready_.empty()) {
      auto [callback, result] = std::move(ready_.front());
      ready_.pop_front();
      callback(result);
      ++invoked;
    }
    return invoked;
  }

  // 取消全部未决请求并排空回调,直到运行时完全空闲。
  void drain() {
    while (pending_count_ > 0 || !ready_.empty()) {
      for (std::uint32_t i = 0; i < slots_.size(); ++i)
        if (slots_[i].occupied)
          finish(i, io_result{io_status::cancelled, 0});
      run();
    }
  }

  bool idle() const noexcept { return pending_count_ == 0 && ready_.empty(); }
  std::size_t pending_count() const noexcept { return pending_count_; }
  std::uint64_t clock() const noexcept { return clock_; }

private:
  struct slot_state {
    std::uint64_t generation = 1;
    bool occupied = false;
    io_callback callback;
  };

  // (截止时间, 槽位, 代次);并列时按槽位下标排序,保证确定性。
  using timer_key = std::tuple<std::uint64_t, std::uint32_t, std::uint64_t>;

  io_handle submit_impl(io_callback callback,
                        std::optional<std::uint64_t> deadline) {
    if (!callback) throw std::invalid_argument("io callback must be callable");
    compact_timers();
    if (free_slots_.empty())
      throw std::length_error("async_io_runtime capacity exhausted");

    const std::uint32_t index = free_slots_.back();
    free_slots_.pop_back();
    slot_state& slot = slots_[index];
    slot.occupied = true;
    slot.callback = std::move(callback);
    ++pending_count_;
    if (deadline) timers_.emplace(*deadline, index, slot.generation);
    return io_handle(index, slot.generation);
  }

  const slot_state* resolve(io_handle handle) const noexcept {
    if (handle.slot_ >= slots_.size()) return nullptr;
    const slot_state& slot = slots_[handle.slot_];
    if (!slot.occupied || slot.generation != handle.generation_) return nullptr;
    return &slot;
  }

  // 唯一的终态迁移点:回调移入就绪队列,槽位立即回收并递增代次。
  // 此后任何携带旧代次的句柄都无法再影响该槽位上的新请求。
  void finish(std::uint32_t index, io_result result) {
    slot_state& slot = slots_[index];
    ready_.emplace_back(std::move(slot.callback), result);
    slot.callback = nullptr;
    slot.occupied = false;
    ++slot.generation;
    free_slots_.push_back(index);
    --pending_count_;
  }

  // 定时器堆采用惰性删除,此处定期压实,把内存占用约束在 O(capacity)。
  void compact_timers() {
    if (timers_.size() <= slots_.size() * 4 + 64) return;
    std::vector<timer_key> live;
    live.reserve(timers_.size());
    while (!timers_.empty()) {
      const timer_key key = timers_.top();
      timers_.pop();
      const auto [deadline, index, generation] = key;
      if (slots_[index].occupied && slots_[index].generation == generation)
        live.push_back(key);
    }
    timers_ = std::priority_queue<timer_key, std::vector<timer_key>,
                                  std::greater<timer_key>>(
        std::greater<timer_key>{}, std::move(live));
  }

  std::vector<slot_state> slots_;
  std::vector<std::uint32_t> free_slots_;
  std::deque<std::pair<io_callback, io_result>> ready_;
  std::priority_queue<timer_key, std::vector<timer_key>,
                      std::greater<timer_key>>
      timers_;
  std::uint64_t clock_ = 0;
  std::size_t pending_count_ = 0;
  bool running_ = false;
};

}  // namespace dlks_formal
