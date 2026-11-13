# CoAP Observe 序列新旧判断

受限设备采集器需要可嵌入 C++ CoAP Observe 状态组件，按24位序列的半范围规则、响应时间和 Max-Age 判断新旧通知。重注册开启新世代，旧 token 的迟到包失效；confirmable 重传只交付一次。休眠超过规则窗口时要求重新同步，不猜序列。

## 组件

`dataeng::ObserveState`（`dataeng.hpp` / `dataeng.cpp`，C++20，仅依赖标准库）：

- `sequence_precedes(a, b)`：24 位序列半范围比较（RFC 7641 §3.4）。
- `reregister(token, now)`：开启新世代，旧 token 的迟到包判 `kWrongEpoch`。
- `on_notification(n, now)`：返回 `kDeliver` / `kDuplicate` / `kStale` / `kWrongEpoch` / `kResyncRequired`；confirmable 按 message id 去重，只交付一次。
- `fresh(now)`：按最近通知的 Max-Age（缺省 60s）判断缓存新鲜度。
- 距上一通知超过序列窗口（默认 128s，如休眠后）判 `kResyncRequired`，不猜序列。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure
```
