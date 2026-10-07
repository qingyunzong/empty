# VM 时光回溯调试器（Record & Replay Debugger）

TypeScript 实现的调试库：记录虚拟机指令执行与外部输入，支持跳到任意事件序号恢复
寄存器与堆后继续执行；回放时自动使用记录的输入，引入新输入会分叉出新版本；
断点不计入执行事件；并提供逐步回放与完整状态快照的一致性核验。

## 运行测试

```sh
npm test
```

（零依赖：用全局 `tsc` 编译到 `dist/`，再用 `node --test` 跑 `test/`。）

## 核心概念

- **事件（TraceEvent）**：每执行一条指令产生一个 `exec` 事件；每条 `in` 指令消费
  外部输入前额外产生一个 `input` 事件。事件序号 `seq` 从 1 单调递增。
  断点命中只是暂停，不产生事件。
- **快照（Snapshot）**：每隔 `snapshotInterval` 个事件保存一次完整状态
  （`pc`、寄存器、堆、输出、halt 标志），seq 0 保存初始状态。
- **版本（Version）**：事件流的分叉树。每个版本记录 `forkSeq`（与父版本的分叉点）
  及分叉点之后自己的事件与快照；分叉点之前的历史沿父链共享。

## API 概览（`Debugger`）

| 方法 | 说明 |
| --- | --- |
| `run({ breakpoints, maxEvents })` | 执行直到 `halt` / 断点 / 缺输入 / 达事件上限 |
| `step()` | 单步执行一条指令（一个事件），忽略断点 |
| `seekTo(seq)` | 跳到任意事件序号：找最近快照恢复寄存器和堆，再回放至目标 seq |
| `provideInput(value)` | 排队一个外部输入 |
| `checkout(versionId)` | 切换到某个版本并跳到其末端 |
| `verify(versionId?)` | 从初始状态逐步回放，逐快照比对完整状态 |
| `events` / `state` / `seq` / `tipOf()` | 当前可见事件流 / 状态拷贝 / 当前序号 / 末端序号 |

## 输入与分叉规则

- 继续执行遇到 `in` 时，若记录中有对应 `input` 事件，直接使用记录值（不产生新版本）。
- 提供的新输入与记录值不同，或当前位置之后仍存在已记录的事件流（即会覆盖历史）时，
  自动分叉子版本，新输入及后续事件记录到子版本，原版本时间线保持不变。
- 在记录末端（live tip）追加新输入属于正常录制，直接扩展当前版本。

## 示例

```ts
import { Debugger, Instruction } from "./src/index.js";

const program: Instruction[] = [/* ... */];
const dbg = new Debugger(program, { snapshotInterval: 16 });

dbg.provideInput(10);
dbg.run({ breakpoints: [3] });   // 在 pc=3 处暂停，不产生事件
dbg.run();                        // 继续，使用记录的输入

dbg.seekTo(42);                   // 跳到事件 42，恢复寄存器与堆
dbg.provideInput(99);             // 与记录不同的新输入
dbg.run();                        // 自动分叉 version 1，原版本保留

dbg.verify();                     // 逐步回放并核验所有快照
dbg.checkout(0);                  // 回到原始时间线
```

## 文件结构

- `src/vm.ts` — 寄存器/堆虚拟机与指令集（`const/mov/add/sub/mul/load/store/jmp/jz/in/out/halt`）
- `src/debugger.ts` — 事件溯源、版本分叉、快照、seek、断点、核验
- `test/debugger.test.ts` — 11 个 `node:test` 测试覆盖上述全部行为
