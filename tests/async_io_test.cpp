// async_io_runtime 的确定性行为验证:
//   * 终态唯一:同一事件序列下每个请求收敛到唯一终态。
//   * 恰好一次:每个已提交请求的回调恰好被调用一次。
//   * 代次隔离:槽位复用后,旧句柄的迟到事件不得唤醒新请求。
//   * 销毁前排空:析构时所有回调以终态调用完毕,无悬挂访问。
// 配合 ASan/UBSan 构建(见 CMakeLists.txt)做内存检查。

#include <dlks_formal.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <vector>

using namespace dlks_formal;

static int g_failures = 0;

#define CHECK(cond)                                                       \
  do {                                                                    \
    if (!(cond)) {                                                        \
      ++g_failures;                                                       \
      std::fprintf(stderr, "CHECK failed %s:%d: %s\n", __FILE__,          \
                   __LINE__, #cond);                                      \
    }                                                                     \
  } while (0)

static const char* to_string(io_status status) {
  switch (status) {
    case io_status::completed: return "completed";
    case io_status::cancelled: return "cancelled";
    case io_status::timed_out: return "timed_out";
  }
  return "?";
}

static void test_basic_completion() {
  async_io_runtime rt(2);
  int calls = 0;
  std::uint64_t value = 0;
  io_handle h = rt.submit([&](io_result r) {
    ++calls;
    CHECK(r.status == io_status::completed);
    value = r.value;
  });
  CHECK(h);
  CHECK(rt.pending_count() == 1);
  CHECK(rt.complete(h, 4096));
  CHECK(calls == 0);  // run() 之前回调不得触发
  CHECK(rt.run() == 1);
  CHECK(calls == 1);
  CHECK(value == 4096);
  CHECK(rt.idle());
}

static void test_cancel_beats_completion() {
  async_io_runtime rt(1);
  int calls = 0;
  io_status seen = io_status::completed;
  io_handle h = rt.submit([&](io_result r) {
    ++calls;
    seen = r.status;
  });
  CHECK(rt.cancel(h));
  CHECK(!rt.complete(h, 1));  // 迟到的完成必须被拒绝
  CHECK(rt.run() == 1);
  CHECK(calls == 1);
  CHECK(seen == io_status::cancelled);
}

static void test_timeout_race() {
  // 超时先到达:完成迟到,句柄失效。
  {
    async_io_runtime rt(1);
    int calls = 0;
    io_status seen = io_status::completed;
    io_handle h = rt.submit(
        [&](io_result r) {
          ++calls;
          seen = r.status;
        },
        10);
    rt.advance_clock(10);
    CHECK(!rt.complete(h, 1));
    CHECK(rt.run() == 1);
    CHECK(calls == 1);
    CHECK(seen == io_status::timed_out);
  }
  // 完成先到达:超时不再生效。
  {
    async_io_runtime rt(1);
    int calls = 0;
    io_status seen = io_status::cancelled;
    std::uint64_t value = 0;
    io_handle h = rt.submit(
        [&](io_result r) {
          ++calls;
          seen = r.status;
          value = r.value;
        },
        10);
    CHECK(rt.complete(h, 7));
    rt.advance_clock(10);
    CHECK(rt.run() == 1);
    CHECK(calls == 1);
    CHECK(seen == io_status::completed);
    CHECK(value == 7);
  }
}

static void test_slot_reuse_stale_handle() {
  async_io_runtime rt(1);  // 容量 1,强制槽位复用
  int a_calls = 0;
  int b_calls = 0;
  io_handle a = rt.submit([&](io_result) { ++a_calls; });
  CHECK(rt.complete(a, 1));
  CHECK(rt.run() == 1);
  CHECK(a_calls == 1);

  io_handle b = rt.submit([&](io_result) { ++b_calls; });
  // 同一槽位新一代次:旧句柄 a 的迟到事件不得唤醒 b。
  CHECK(!rt.complete(a, 99));
  CHECK(!rt.cancel(a));
  CHECK(rt.run() == 0);
  CHECK(b_calls == 0);
  CHECK(rt.complete(b, 2));
  CHECK(rt.run() == 1);
  CHECK(b_calls == 1);
  CHECK(rt.idle());
}

static void test_destructor_drains() {
  int calls = 0;
  int completed = 0;
  int cancelled = 0;
  {
    async_io_runtime rt(3);
    io_handle done = rt.submit([&](io_result r) {
      ++calls;
      completed += r.status == io_status::completed ? 1 : 0;
    });
    (void)rt.submit([&](io_result r) {
      ++calls;
      cancelled += r.status == io_status::cancelled ? 1 : 0;
    });
    (void)rt.submit(
        [&](io_result r) {
          ++calls;
          cancelled += r.status == io_status::cancelled ? 1 : 0;
        },
        10);
    CHECK(rt.complete(done, 1));
    // 不调用 run():就绪队列非空 + 两个未决请求,直接析构。
  }
  // 析构前排空:全部回调恰好一次,终态分别为 completed/cancelled。
  CHECK(calls == 3);
  CHECK(completed == 1);
  CHECK(cancelled == 2);
}

// 确定性事件排列:3 个请求,每个有 complete/cancel 两个竞争事件,
// 外加一次越过全部截止时间的时钟推进,共 7 个事件的全部 5040 种排列。
// 对每种排列,每个请求的终态必须由排列中首个触及它的事件唯一决定,
// 且回调恰好一次。
enum class ev_kind { complete, cancel, tick };

struct ev {
  ev_kind kind;
  int op;
};

static bool ev_less(const ev& a, const ev& b) {
  if (a.kind != b.kind) return a.kind < b.kind;
  return a.op < b.op;
}

static void test_event_permutations() {
  constexpr int op_count = 3;
  constexpr std::uint64_t deadline = 100;

  std::vector<ev> events;
  for (int i = 0; i < op_count; ++i) {
    events.push_back({ev_kind::complete, i});
    events.push_back({ev_kind::cancel, i});
  }
  events.push_back({ev_kind::tick, -1});
  std::sort(events.begin(), events.end(), ev_less);

  std::size_t permutations = 0;
  do {
    async_io_runtime rt(8);
    std::vector<io_handle> handles(op_count);
    std::vector<int> calls(op_count, 0);
    std::vector<io_status> final_status(op_count, io_status::completed);
    for (int i = 0; i < op_count; ++i)
      handles[i] = rt.submit(
          [&, i](io_result r) {
            ++calls[i];
            final_status[i] = r.status;
          },
          deadline);

    for (const ev& e : events) {
      switch (e.kind) {
        case ev_kind::complete: rt.complete(handles[e.op], 1); break;
        case ev_kind::cancel: rt.cancel(handles[e.op]); break;
        case ev_kind::tick: rt.advance_clock(deadline); break;
      }
    }
    rt.drain();

    for (int i = 0; i < op_count; ++i) {
      // 期望终态:排列中首个触及该请求的事件(超时事件触及所有请求)。
      io_status expected = io_status::cancelled;  // drain 兜底
      for (const ev& e : events) {
        if (e.kind == ev_kind::tick) {
          expected = io_status::timed_out;
          break;
        }
        if (e.op == i) {
          expected = e.kind == ev_kind::complete ? io_status::completed
                                                 : io_status::cancelled;
          break;
        }
      }
      if (calls[i] != 1 || final_status[i] != expected) {
        ++g_failures;
        std::fprintf(stderr,
                     "permutation %zu op %d: calls=%d status=%s expected=%s\n",
                     permutations, i, calls[i], to_string(final_status[i]),
                     to_string(expected));
      }
    }
    CHECK(rt.idle());
    ++permutations;
  } while (std::next_permutation(events.begin(), events.end(), ev_less));

  CHECK(permutations == 5040);
}

static void test_timeout_order_deterministic() {
  async_io_runtime rt(3);
  std::vector<int> order;
  for (int i = 0; i < 3; ++i)
    (void)rt.submit([&order, i](io_result) { order.push_back(i); }, 50);
  rt.advance_clock(50);
  rt.run();
  // 相同截止时间按槽位下标打破并列,顺序必须确定。
  CHECK((order == std::vector<int>{0, 1, 2}));
}

static void test_reentrant_callback() {
  async_io_runtime rt(2);
  int a_calls = 0;
  int b_calls = 0;
  io_handle hb;
  io_handle ha = rt.submit([&](io_result r) {
    ++a_calls;
    CHECK(r.status == io_status::completed);
    CHECK(rt.complete(hb, 5));  // 回调内完成另一个请求
    CHECK(rt.run() == 0);       // 重入 run() 被守卫,外层继续排空
  });
  hb = rt.submit([&](io_result r) {
    ++b_calls;
    CHECK(r.status == io_status::completed);
    CHECK(r.value == 5);
  });
  CHECK(rt.complete(ha, 1));
  CHECK(rt.run() == 2);  // 同一次 run 排空 A 与级联的 B
  CHECK(a_calls == 1);
  CHECK(b_calls == 1);
  CHECK(rt.idle());
}

static void test_capacity_and_invalid_handles() {
  async_io_runtime rt(1);
  io_handle h = rt.submit([](io_result) {});

  bool threw = false;
  try {
    (void)rt.submit([](io_result) {});
  } catch (const std::length_error&) {
    threw = true;
  }
  CHECK(threw);

  threw = false;
  try {
    (void)rt.submit(nullptr);
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  CHECK(threw);

  io_handle empty;
  CHECK(!empty);
  CHECK(!rt.complete(empty));
  CHECK(!rt.cancel(empty));

  // 双重终态:第二次迁移必须被拒绝。
  CHECK(rt.complete(h, 1));
  CHECK(!rt.complete(h, 2));
  CHECK(!rt.cancel(h));
  CHECK(rt.run() == 1);
  CHECK(rt.idle());
}

// 确定性压力测试:xorshift 伪随机交错提交/完成/取消/超时/陈旧探测,
// 同种子两次运行结果必须逐位一致(确定性),且终态计数自洽。
struct stress_model {
  std::uint64_t submitted = 0;
  std::uint64_t invoked = 0;
  std::uint64_t completed = 0;
  std::uint64_t cancelled = 0;
  std::uint64_t timed_out = 0;
  std::uint64_t stale_rejected = 0;

  bool operator==(const stress_model&) const = default;
};

static stress_model run_stress(std::uint64_t seed) {
  async_io_runtime rt(4);
  stress_model model;
  std::uint64_t rng = seed;
  auto next = [&]() {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
  };
  std::vector<io_handle> live;
  std::vector<io_handle> graveyard;

  auto record = [&](io_result r) {
    ++model.invoked;
    switch (r.status) {
      case io_status::completed: ++model.completed; break;
      case io_status::cancelled: ++model.cancelled; break;
      case io_status::timed_out: ++model.timed_out; break;
    }
  };

  for (int iter = 0; iter < 20000; ++iter) {
    switch (next() % 6) {
      case 0:
      case 1: {
        if (rt.pending_count() < 4) {
          io_handle h = (next() % 2)
                            ? rt.submit(record, rt.clock() + next() % 4)
                            : rt.submit(record);
          live.push_back(h);
          ++model.submitted;
        }
        break;
      }
      case 2:
      case 3: {
        if (live.empty()) break;
        const std::size_t i = next() % live.size();
        const io_handle h = live[i];
        live.erase(live.begin() + i);
        // 句柄可能已因超时进入终态;无论返回值如何,此后它必然失效。
        if (next() % 2)
          rt.complete(h, next() % 100);
        else
          rt.cancel(h);
        graveyard.push_back(h);
        break;
      }
      case 4: {
        // 陈旧句柄探测:已终态的句柄上任何事件都必须被拒绝。
        if (graveyard.empty()) break;
        const io_handle h = graveyard[next() % graveyard.size()];
        CHECK(!rt.complete(h, 1));
        CHECK(!rt.cancel(h));
        ++model.stale_rejected;
        break;
      }
      case 5: {
        rt.advance_clock(rt.clock() + 1 + next() % 3);
        break;
      }
    }
    rt.run();
  }
  rt.drain();
  CHECK(rt.idle());
  return model;
}

static void test_stress_deterministic() {
  const stress_model first = run_stress(0x9e3779b97f4a7c15ull);
  const stress_model second = run_stress(0x9e3779b97f4a7c15ull);
  CHECK(first == second);  // 同种子 => 相同终态序列

  // 恰好一次:每个已提交请求的回调恰好调用一次。
  CHECK(first.invoked == first.submitted);
  // 终态唯一且完备:completed+cancelled+timed_out 覆盖全部请求。
  CHECK(first.completed + first.cancelled + first.timed_out ==
        first.submitted);
  CHECK(first.submitted > 0);
  CHECK(first.stale_rejected > 0);
}

int main() {
  test_basic_completion();
  test_cancel_beats_completion();
  test_timeout_race();
  test_slot_reuse_stale_handle();
  test_destructor_drains();
  test_event_permutations();
  test_timeout_order_deterministic();
  test_reentrant_callback();
  test_capacity_and_invalid_handles();
  test_stress_deterministic();

  if (g_failures == 0) {
    std::printf("all async_io tests passed\n");
    return 0;
  }
  std::fprintf(stderr, "%d check(s) failed\n", g_failures);
  return 1;
}
