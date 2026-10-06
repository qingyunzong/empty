# fencing_sim

Fencing-token 任务模拟库（C++20，header-only）：签发器把单调递增的栅栏号授给
持有者，存储只接受不小于已接受号的写；租约过期不会撤销已存储的结果，旧持有者
的迟到写被拒绝。所有授予与写都留下证据轨迹，核验器在有界故障模型下重放轨迹并
检查安全不变式。

## 组件

- `fencing::TokenIssuer` — 单调栅栏号签发，同一时刻仅一个有效租约（`include/fencing/issuer.hpp`）
- `fencing::FencingStorage` —  fencing 寄存器：`token >= accepted_token` 才接受写（`include/fencing/storage.hpp`）
- `fencing::Simulation` — 逻辑时钟驱动，注入租约过期/持有者崩溃等有界故障（`include/fencing/simulation.hpp`）
- `fencing::verify_bounded_faults` — 重放 `Trace`，核验单调授予、写接受不降序、
  迟到写必拒绝、过期租约不写、故障数不超过上界（`include/fencing/verifier.hpp`）

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

四个 CTest 可执行测试：`issuer`、`storage`、`simulation`、`verifier`。
