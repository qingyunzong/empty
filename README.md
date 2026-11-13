# 增量物化视图修订

查询引擎需要可嵌入 C++ 增量聚合状态库，接收带正负 multiplicity 的行，维护 group sum/count/min/max。min/max 删除当前极值时从有界有序状态选下一值；计数归零删除组。更新前后作为同事务应用，中间状态不对读者可见。

## 实现

`dataeng.hpp` 是自包含、header-only 的 C++20 库，核心类型为
`dataeng::IncrementalAggregator<Key, Value>`（别名 `AggregationState`）。

每个组维护一份不可变状态：

- `count`：组内所有行的 multiplicity 之和。
- `sum`：`value * multiplicity` 的增量累加。
- `ordered`：`std::map<Value, multiplicity_t>`，只保存仍有正 multiplicity 的
  不同 value 及其计数。取 min/max 是 `begin()`/`rbegin()`；删除当前极值时先
  将对应计数减到零并从有序表移除，再自然取得下一个极值。状态大小只随不同
  value 的数量增长，与 multiplicity 大小无关。

批次提交分为两阶段：

1. 先将批次按 `(group, value)` 汇总为净增量，因此同一事务内的行序不影响结果。
2. 在独占锁内基于旧状态计算所有组的新状态，全部校验通过后一次性替换；
   任一行非法（如撤回超过已有 multiplicity）时抛出 `transaction_error`，
   不发布任何部分状态。

读者通过 `snapshot()` 获取不可变快照；已获取的快照在后续写入后仍然有效。
也可以直接调用 `find()`/`contains()`/`size()`，它们持有共享锁，只会看到某次
事务提交前或提交后的完整状态。写入串行化，读取可并发。

组删除：某组 `count` 变为 `0` 时整组从状态中删除；再次插入会创建全新的组。
零 multiplicity 行是空操作。

## 用法

```cpp
#include "dataeng.hpp"

dataeng::IncrementalAggregator<std::string, std::int64_t> agg;
agg.apply({
    {"sales", 10, 2},
    {"sales", 30, 1},
    {"ops", 7, 1},
});

auto view = agg.snapshot();
auto sales = view->find("sales");
// sales->sum == 50, sales->count == 3, sales->min == 10, sales->max == 30

dataeng::IncrementalAggregator<std::string, std::int64_t>::Transaction tx;
tx.retract("sales", 30, 1).insert("sales", 20, 1);
agg.apply(tx);  // 两个变更为同一事务，读者不会看到中间状态
```

也可以直接使用 `agg.insert(key, value, multiplicity)`、
`agg.retract(key, value, multiplicity)`，或传入 `std::vector<Row>` /
`std::span<const Row>` / `initializer_list<Row>` / 单条 `Row`。

`Value` 需满足 `AggregateValue` 约束：可默认构造、全序、支持 `+=`、`-=`
以及 `value * multiplicity`。整数类型请选择足够宽的类型，使 group sum 不溢出。

## 复杂度

- 单次提交：`O(R log D + D log D + G')`，其中 `R` 为输入行数，`D` 为受影响
  组内不同 value 数，`G'` 为受影响组数；另有哈希表预留开销。
- 取快照：`O(G)`（复制组指针表），快照本身不可变。
- 单组内存：`O(D)`，与行 multiplicity 总量无关。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
ctest --test-dir build --output-on-failure
```
