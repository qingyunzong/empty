# state-sequence

状态序列库（TypeScript，仅 Node.js 内置库，零依赖）。

## 语义

- **保持**：每个样本自其 tick 起保持，直到下一个样本的 tick 或自身 TTL 到期（取先到者）；无 TTL 则一直保持到下一个样本。
- **过期空洞不能延长**：TTL 到期后留下空洞（`null`）；删除后继样本不会让已过期样本复活，空洞一直延伸到下一个有效样本。
- **同时间更正**：同一 tick 上版本（`version`）高者胜出；版本等于或低于现有版本的插入被拒绝。
- **范围查询**：`query(start, end)` 在半开区间 `[start, end)` 上输出**最大等值半开段**，相邻等值段（含空洞）合并，空洞以 `value: null` 表示。
- **逐 tick 解释器**：`src/interpreter.ts` 从原始样本列表逐 tick 独立求值，作为参考实现，测试用它核对插入与删除后的 `valueAt` 与 `query` 输出。

## API

```ts
const seq = new StateSequence();
seq.insert({ time: 0, value: "a", version: 1, ttl: 4 }); // => true
seq.insert({ time: 0, value: "b", version: 2 });        // 同 tick 高版本，替换
seq.delete(10);                                          // 按 tick 删除，可选 version 守卫
seq.valueAt(3);                                          // 单点求值，空洞为 null
seq.query(0, 12);                                        // => [{start,end,value}, ...]
```

## 测试

```sh
npm test   # tsc 编译后由 node --test 运行
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-05 执行 `npm test`，10 项测试全部通过：

```
ok 1 - a sample holds until the next sample
ok 2 - a sample expires at its own TTL, leaving a hole
ok 3 - an expired hole is not extended by deleting the successor
ok 4 - corrections at the same time: the higher version wins
ok 5 - query merges adjacent equal values into maximal segments
ok 6 - query clips to the half-open range [start, end)
ok 7 - delete removes samples, optionally guarded by version
ok 8 - interpreter sanity: per-tick values over a hand-built sample list
ok 9 - randomized inserts and deletes cross-checked against the per-tick interpreter
ok 10 - segment boundaries stay half-open under dense same-tick corrections
# tests 10
# pass 10
# fail 0
```
