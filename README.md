# dlks_formal

可嵌入的 C++20 一致性哈希环组件（纯头文件，无第三方依赖）。

## 组件

- `include/dlks_formal/consistent_hash_ring.hpp`
  - `Ring`：不可变哈希环快照。
  - `RingBuilder`：按 upsert 语义增删节点后构建环。
  - `SharedRing`：线程安全包装，节点抖动时原子发布不可变快照。
  - `Ring::diff(old, new)`：计算两个环之间的最小迁移集合。
  - `fnv1a64`：默认确定性 64 位 FNV-1a 哈希，可通过 `Ring::Options`
    注入自定义哈希与每权重虚拟节点数（默认 160）。

## 语义约定

- 节点权重为 `weight` 时放置 `weight * vnodes_per_weight` 个虚拟节点，
  位置为 `hasher(name + "#" + vindex)`。
- 查找：键哈希后取环上顺时针首个虚拟节点（`lower_bound`，越界回绕）；
  空环返回 `std::nullopt`。
- 零权重节点仍登记在节点列表中，但不产生虚拟节点、不拥有任何键。
- 重名节点按 upsert 处理，最后一次写入的权重生效。
- 虚拟节点位置碰撞时按稳定规则去重：节点名字典序最小者胜，再按
  `vindex` 最小者胜；构建结果与输入顺序无关。
- 迁移：以两个环全部虚拟节点位置的并集切分键空间，仅当某段属主
  变化时才输出一条 `Migration`，因此权重调整只迁移受影响区间。
  迁移弧 `(lo, hi]` 对应虚拟节点“拥有 `(前驱, 自身]`”的归属规则，
  `lo == hi` 表示整圈。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试用小模数哈希制造大量碰撞，穷举 2048 个小环并与独立实现的朴素环
模型逐项核对虚拟节点、键归属与迁移集合；并发测试在四个读线程与持续
节点抖动交错时验证快照一致性（无撕裂分配）。
