# fsm-failure-minimizer

诊断 CLI：给定一台有限状态机和一段**失败**的事件历史，通过“删除连续块并重测”
把历史缩减到 **1-最小**——再删任何一个单事件都不再失败。非法历史（在某状态
下事件没有对应转移）**不**被当作失败。每一次判断都写入 JSONL 轨迹，
`replay` 命令可确定性地重现全部判定。

仅使用 TypeScript + Node.js 内置模块，无运行时依赖。

## 输入格式

```json
{
  "machine": {
    "states": ["c0", "c1", "c2", "bad"],
    "initial": "c0",
    "failureStates": ["bad"],
    "transitions": { "c0": { "tick": "c1" } }
  },
  "events": ["x", "tick", "y", "tick", "x", "tick", "y"]
}
```

判定规则：历史能从初始状态完整走通且停在 `failureStates` 之一 → `fail`；
能走通但未停在失败状态 → `pass`；中途没有可用转移 → `invalid`（绝不视为失败）。

## 用法

```sh
npm run build
node dist/src/cli.js run examples/counter.json --trace trace.jsonl
node dist/src/cli.js replay trace.jsonl
```

- `run`：缩减并写出轨迹。退出码：`0` 成功；`1` 用法/输入/状态机非法；
  `2` 输入历史本身不失败。
- `replay`：重放轨迹，对嵌入的状态机逐条重算判定并独立复检最终结果
  仍失败且 1-最小；任何不一致以退出码 `3` 报告。

## 缩减算法

从“当前长度的一半”的块长开始，按起点升序扫描所有连续块，删除后仍失败
则接受该删除并重新开始；整块长扫描无果则块长减半。块长为 1 仍无果时退出，
随后再逐事件复检一遍（`single-delete-check`），保证结果 1-最小。
扫描顺序固定，同一输入产生完全相同的判断序列。

## 轨迹格式（JSONL）

- `header`：状态机与原始事件序列（自包含，replay 只需轨迹文件）。
- `judge`：每一次重测——`action`（`initial` / `block-delete` /
  `single-delete-check`）、被删区间、候选序列、判定、是否被接受。
- `final`：缩减结果、1-最小标志、判断总数。

## 测试

```sh
npm test    # tsc 编译 + node --test
```

实际运行结果见 `TEST_RESULTS.md`。
