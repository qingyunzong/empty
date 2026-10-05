# event-compressor

事件压缩库（TypeScript + Node.js 内置库，零运行时依赖）。

## 规则

- 事件流由 `put` 事件（`id` / `key` / 每键递增 `version` / 字节负载 `data`）与显式 `barrier` 事件组成。
- `compress()` 把**相邻、同键、版本连续**的 `put` 合并为一个分组；分组输出**初值**（`initialValue`）、**终值**（`finalValue`）与**被合并 ID**（`mergedIds`）。
- `barrier` 永不参与合并，且**禁止跨越**：屏障两侧的同键事件分属不同分组。
- 每个分组保留全部帧（`frames`），`decompress()` 据此还原原始事件顺序，逆压缩后字节序列与输入完全一致（无损）。

## 使用

```bash
npm test        # 编译 (tsc) 并运行 node:test 测试
npm run demo    # 打印一次压缩摘要与还原校验
npm run typecheck
```

要求 Node.js >= 18（测试运行器 `node:test`）与 `tsc`（TypeScript 编译器）。

## 接口

- `compress(events: StreamEvent[]): CompressedRecord[]`
- `decompress(records: CompressedRecord[]): StreamEvent[]`
- `serializeStream(events): Buffer` — 确定性字节序列化，用于还原一致性核对
- `summarize(records): string[]` — 每组一行：初值 / 终值 / 被合并 ID

## 实际运行结果（2026-10-06，Node v22.22.1）

`npm test`：

```
# Subtest: merges consecutive versions of the same key into one group
ok 1 - merges consecutive versions of the same key into one group
# Subtest: explicit barrier forbids merging across it
ok 2 - explicit barrier forbids merging across it
# Subtest: key change or non-consecutive version starts a new group
ok 3 - key change or non-consecutive version starts a new group
# Subtest: summary reports initial value, final value and merged ids
ok 4 - summary reports initial value, final value and merged ids
# Subtest: decompress restores the original event order and bytes
ok 5 - decompress restores the original event order and bytes
# Subtest: empty stream compresses to nothing
ok 6 - empty stream compresses to nothing
# Subtest: random barriers interleaved with same keys: round-trip byte sequence is identical
ok 7 - random barriers interleaved with same keys: round-trip byte sequence is identical
1..7
# tests 7
# pass 7
# fail 0
```

随机核对（测试 7）：500 轮种子化随机流，每轮随机插入约 25% 屏障、3 个键交错、
85% 版本连续 / 15% 跳版、0–16 字节随机负载；每轮断言
`decompress(compress(x))` 与原始流深度相等、序列化字节序列一致、
分组不跨屏障且组内版本连续、初值/终值与首末帧一致。

`npm run demo`：

```
compressed summary:
  group key=alpha versions=1..3 initial=6161 final=6363 mergedIds=[e1,e2,e3]
  barrier id=B1
  group key=alpha versions=4..4 initial=6464 final=6464 mergedIds=[e4]
  group key=beta versions=1..1 initial=7a7a final=7a7a mergedIds=[e5]
round-trip byte sequence identical: true
```

`npm run typecheck`（`tsc --noEmit`，strict）：通过，无错误。

## 结构

- `src/event-compressor.ts` — 压缩 / 逆压缩 / 序列化 / 摘要
- `test/event-compressor.test.ts` — `node:test` + `node:assert/strict` 单元与随机往返测试
- `examples/demo.ts` — 摘要输出演示
- `types/node-shim.d.ts` — 离线环境的最小 Node 类型声明（替代 `@types/node`）
