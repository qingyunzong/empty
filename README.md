# skyline

C++20 矩形天际线库：维护带高度的矩形集合，支持按 ID 增删、历史快照、
逐段最高矩形来源查询与来源变更差量。

## 语义约定

- 区间为**半开** `[left, right)`；负坐标合法。
- `height <= 0` 或 `left >= right` 的矩形定义为**空**，不产生任何贡献。
- `add` 按 ID 原地替换（upsert）；`remove(id)` 只移除该 ID 的贡献，
  被遮挡的较低矩形会重新显现。
- 天际线输出为变化点序列，相邻同高自动合并。

## API 概览（`skyline::Skyline`）

- `add / remove / applyBatch`：单个或批量增删；`applyBatch` 一次提交并返回新快照。
- `snapshot()`：不可变历史快照（共享所有权，拷贝廉价）；`skyline(snap)`、
  `topSegments(snap, l, r)` 可查询任意旧快照。
- `skyline()`：合并后的高度变化点 `{x, height}`。
- `topSegments(ql, qr)`：查询区间内每段的最高高度与**全部**并列来源 ID
  （同高重叠不丢来源）；无覆盖段高度为 0、来源为空。
- `diffSources(oldSnap, newSnap)`：两个快照间的来源变更差量，按最大变更段输出；
  **高度不变但来源变化同样通知**（`SourceChange::heightChanged()` 可区分）。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试包含随机化的端点分段全扫描模型核验（`test_model`）：天际线、
`topSegments`、`diffSources` 均与逐端点暴力模型交叉验证。
