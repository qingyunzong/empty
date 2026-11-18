# dlks_formal

无依赖、header-only 的 C++20 SLO 错误预算与多窗口燃烧率组件。

## 使用

```cpp
#include "dlks_formal.hpp"
#include <chrono>

using namespace std::chrono_literals;

dlks_formal::ErrorBudgetConfig config{
    .slo_period = 30 * 24h,
    .allowed_error_ratio = 0.001,
    .windows = {5min, 1h},
    .alerts = {
        dlks_formal::BurnRateAlert{
            .name = "page",
            .level = 2,
            .short_window = 5min,
            .long_window = 1h,
            .short_threshold = 14.4,
            .long_threshold = 6.0,
        },
    },
};

dlks_formal::SloErrorBudget budget(std::move(config));

const auto at = dlks_formal::Nanoseconds{std::chrono::seconds{10}};
budget.success(at);
budget.error(at);

const dlks_formal::Snapshot state = budget.snapshot_at(at);
const auto* short_window = state.find_window(5min);
```

时间戳与窗口均使用调用方提供的 `std::chrono::nanoseconds`。`observe`/`success`/`error`
接受乱序到达的事件；时间只允许通过 `advance_to` 前进，未来时间戳会自动推进时钟。

## 语义

- 滑动窗口为 `(now - W, now]`。样本恰好在 `now - W` 时移出，因此边界不会重复计数或漏计。
- 历史不足一个窗口时按已有样本计算部分窗口，不对未来做外推。
- `burn_rate = (window_errors / window_requests) / allowed_error_ratio`。
- 零请求窗口的 `burn_rate` 为 `0`，且绝不触发告警。
- 每个告警配置独立判断；仅当短窗与长窗都有请求，且两个燃烧率都严格大于各自阈值时触发。多个级别同时触发时报告最高级别，并列出全部触发级别。
- `slo_period_index = floor(timestamp / slo_period)`。进入新周期时预算清零；迟到的旧周期事件不会重新打开旧预算，但只要仍在滑动窗口内仍会参与窗口统计。
- 当前周期预算为 `allowed_error_events = allowed_error_ratio * requests`，
  `remaining_error_events = allowed_error_events - errors`。预算可以为负；零请求时
  `remaining_budget_ratio` 定义为 `1.0`，表示预算未被消耗。
- 所有窗口使用独立的有序队列与计数。事件进入时计数一次，到期时先计数再出队一次，
  因此窗口样本数与预算扣减均可精确守恒。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试以朴素逐事件、逐窗口重算模型为基准，穷举 `3^8` 个事件序列以及 `5^6` 个
窗口滑动/事件到达/迟到事件交错序列，并在每个操作后核对窗口计数、错误比例、
燃烧率、剩余预算和告警级别。
