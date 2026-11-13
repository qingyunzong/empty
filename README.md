# 分位数草图加权归并

监控聚合器要可直接接入 C++ KLL 分位数草图库，处理带正整数权重的样本、层压缩与分片合并。随机性由调用方种子控制，合并顺序变化仍满足秩误差界；NaN 按策略拒绝，正负零排序确定。输出可反序列化并验证总权重守恒。

## 接口

- `dataeng::KllSketch(k, seed, NanPolicy::kReject)`：加权 KLL 分位数草图；随机性完全由调用方种子决定。
- `update(value, weight)`：正整数权重样本；NaN 按策略拒绝（返回 `false`），`weight == 0` 抛 `std::invalid_argument`。
- `merge(other)`：分片合并，要求相同 `k` 与 NaN 策略；`rank_error_bound()` 给出的秩误差界对任意合并顺序成立。
- `quantile(r)` / `rank(v)`：分位数与秩查询；`-0.0` 严格排在 `+0.0` 之前。
- `serialize()` / `deserialize(...)`：字节序列化；反序列化时校验总权重守恒，失败抛 `std::runtime_error`。
- `validate_weight_conservation()`：显式校验各层权重之和等于总权重。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build && ctest --test-dir build
```
