# 时态库存物品位置存储

C++20 实现的双时态(业务区间 × 知悉序号)物品位置存储,仅头文件,附 CMake/CTest 测试。

## 语义

- **业务区间半开**:每条记录的有效区间为 `[from, to)`,`from` 含、`to` 不含。
- **知悉序号**:录入与撤销都是事件,各自获得单调递增的知悉序号 `k`。
- **查询 `query(K, t)`**:在所有知悉可见(`knowledge <= K` 且未被 `K` 可见的撤销命中)
  且覆盖 `t` 的记录中,取**知悉序号最高**者,返回**来源记录本身**(原始区间,不合成片段)。
- **撤销仅在知悉后生效**:撤销事件的序号为 `k_r`,仅当 `K >= k_r` 时被撤销记录才不可见。
- **补录分裂不改旧快照**:补录(晚知悉、早业务时间的记录)按最高知悉序号优先,
  在当前快照中把旧记录分裂成若干段;事件日志只追加,旧 `K` 下的快照完全不变。

## 结构

- `include/temporal/store.hpp` —— `temporal::Store`:`insert` / `revoke` / `query` / `snapshot`
- `src/main.cpp` —— 演示程序(录入 → 补录分裂 → 撤销生效)
- `tests/test_store.cpp` —— 语义单元测试 + **二维小域栅格参考核验**:
  独立朴素参考模型,对全部 `(K, t)` 栅格点与 `Store::query` 逐点比对,
  并校验 `snapshot` 分段与逐点查询一致;含固定种子的随机操作序列回归。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
./build/temporal_demo
```
