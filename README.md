# 双流区间连接水位

流式查询引擎需要可嵌入 C++ interval join 算子，把左右事件按 key 和有界时间差连接。两侧独立水位决定何时可淘汰状态及产生 outer unmatched；迟到匹配在允许期内撤销此前 unmatched 版本。任意到达排列应得到同一最终多重集。

本仓库提供一个无外部依赖的 C++20 实现：`dataeng::IntervalJoin`。

## 语义

连接条件为同 key 且：

```text
left.time + lower <= right.time <= left.time + upper
```

`lower` / `upper` 均为闭区间边界。常见的对称区间可直接用
`IntervalJoin::Bounds::symmetric(d)` 得到 `[-d, +d]`。

每个输入事件只插入一次。某个 pair 在较晚到达的一侧触发查询时产生一条
`Insert/Join`，因此每对匹配事件恰好输出一次，与到达顺序无关。

### 水位

`advance_watermark(side, w)` 声明该侧不会再出现时间戳小于 `w` 的事件。
水位按侧独立维护，且只允许单调前进；回退的水位会被忽略。

设允许迟到为 `L = allowed_lateness`：

- 事件 `time < watermark(side) - L` 会被丢弃，并计入
  `stats().{left,right}_dropped_late`。
- `watermark(side) - L <= time < watermark(side)` 的事件属于迟到但可接受。

### Outer 与撤销

对左侧事件 `l`，当 `right_watermark > l.time + upper` 时，右侧不可能再出现
按时的匹配；若此时 `l` 没有任何匹配，就输出 `Insert/LeftOuter`。右侧对称：
当 `left_watermark > r.time - lower` 时，若 `r` 无匹配则输出
`Insert/RightOuter`。

如果之后在允许迟到窗口内又到达了匹配事件，算子会先输出对应的
`Retract/LeftOuter` 或 `Retract/RightOuter`，再输出 `Insert/Join`。同一个
outer 记录最多撤销一次。

### 状态淘汰

左侧事件 `l` 在 `right_watermark > l.time + upper + L` 后淘汰；右侧事件
`r` 在 `left_watermark > r.time - lower + L` 后淘汰。该阈值保证：只要一个
事件仍能被接受，与它匹配的另一侧事件就不会被提前淘汰。

`finish()` 会把仍保留的事件全部按 outer 规则收尾并清空状态；它可重复调用。
调用 `finish()` 后再输入事件会抛出 `std::logic_error`。

## 输出

```cpp
enum class Change { Insert, Retract };
enum class RecordKind { Join, LeftOuter, RightOuter };

struct Output {
    Change change;
    RecordKind kind;
    std::optional<Event> left;
    std::optional<Event> right;
};
```

- `Insert/Join`：`left` 与 `right` 都存在。
- `Insert/LeftOuter` / `Retract/LeftOuter`：只有 `left`。
- `Insert/RightOuter` / `Retract/RightOuter`：只有 `right`。

最终结果按 changelog 语义计算：`Insert` 加一，`Retract` 减一，计数为零的
记录删除。对所有被接受的事件，无论到达排列如何，最终多重集都等于同一批
事件的批处理区间连接结果（匹配 pair 加未匹配 outer）。

## 使用示例

```cpp
#include "dataeng.hpp"

using namespace dataeng;

IntervalJoin join(IntervalJoin::Bounds::symmetric(5), 10);

std::vector<Output> out;

auto append = [&out](std::vector<Output> next) {
    out.insert(out.end(), next.begin(), next.end());
};

append(join.add_left({"user-1", 100, 1, "click"}));
append(join.advance_watermark(Side::Right, 106));
append(join.add_right({"user-1", 103, 2, "buy"}));
append(join.finish());
```

该示例先产生 `LeftOuter(100)`，随后迟到匹配到达，产生
`Retract(LeftOuter(100))` 和 `Join(100, 103)`，最终多重集中只剩连接结果。

`Event` 的字段依次为 `key`、`time`、`id`、`payload`。`id` 仅用于业务侧
标识，算子不要求其唯一；每次 `add_left` / `add_right` 都视为一条独立事件。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试覆盖闭区间边界、非对称区间、双侧 outer、迟到撤销、允许期淘汰、
单调水位、极端时间戳饱和，以及多组随机事件排列和随机水位调度与暴力批处理
参考结果的比对。

## 复杂度

事件插入与匹配按 key 和 timestamp 索引，单次查询为
`O(log n + k)`，`k` 为命中的对侧事件数。水位推进只处理已经跨过阈值的
timestamp 桶，因此每个事件在 outer 和淘汰阶段各被处理一次。实现为单线程
组件，不持有锁。
