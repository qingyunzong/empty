# vm-time-travel-debugger

一个可时间回溯的虚拟机调试库（TypeScript）：记录虚拟机的指令执行与外部输入，
支持跳到任意事件序号恢复寄存器与堆、用记录输入继续回放，输入发生分叉时
自动派生新版本，并提供逐步回放与完整状态快照核验。

## 运行测试

```sh
npm test   # tsc 编译后用 node --test 运行全部测试
```

## 组成

- `src/vm.ts` — 寄存器 + 堆的小型虚拟机。指令集：`LOADI/LOAD/STORE/MOV/ADD/ADDI/SUB/MUL/JMP/JZ/IN/OUT/HALT`。
  提供 `snapshot()` / `restore()` 完整状态（寄存器、堆、pc、输出、已消费输入数），
  `hashState()` 对状态做确定性 SHA-1 摘要。
- `src/session.ts` — `DebugSession` 调试会话：事件日志、时间跳转、版本分叉、断点、回放核验。
- `test/` — 基于 `node:test` 的测试（16 个用例）。

## 核心概念

- **执行事件**：每执行一条指令记录一个 `ExecEvent`（序号 `seq`、pc、反汇编、
  消耗的输入、执行后的完整状态快照及其哈希）。只有执行的指令才产生事件，
  **断点命中不算事件**（单独记录在 `breakpointHits`）。
- **外部输入**：`IN` 指令消费的值随事件记录，并按消费顺序存入版本的 `inputs`。
- **时间跳转**：`jumpTo(seq)` 把寄存器、堆等完整状态恢复到该事件执行后
  （`-1` 为初始状态），之后 `continue()` / `step()` 进入回放模式。
- **回放核验**：回放时逐步重新执行，逐步比对 pc/指令/输入与完整状态哈希；
  一致则复用原事件，不新增事件。`verify()` 可从初始状态完整重放整个版本，
  并校验每个快照的自完整性（存储状态与存储哈希一致）。
- **分叉**：回放中通过 `supplyInput()` 提供与记录不同的新输入时，自动从当前
  位置分叉出新 `Version`（复制共享前缀，记录 `parentId` 与 `forkSeq`），
  原版本保持不变；输入与记录一致则不分叉。`forkAt(seq)` 可显式分叉。

## API 摘要

```ts
const session = new DebugSession(program);
session.continue([5, 7, 0]);   // 记录执行，直到 halt / 断点 / 缺输入
session.jumpTo(5);             // 恢复到事件 5 之后的状态
session.continue();            // 用记录输入回放，逐步核验
session.supplyInput(9);        // 与记录不同 => 下一步自动分叉版本
session.setBreakpoint(2);      // 断点命中会暂停，但不产生执行事件
session.snapshotAt(8);         // 任意事件的完整状态快照（深拷贝）
session.verify();              // 逐步回放 + 全量快照哈希核验
session.listVersions();        // 版本树（id / parentId / forkSeq / ...）
```
