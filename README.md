# thread-schedule-simulator

一个确定性的并发程序模拟器（TypeScript，零依赖）：模拟 **≤3 个线程** 在共享内存上的
**读写、互斥锁与分支** 执行，按输入的 **调度序列逐步推进**；当没有任何可运行线程且程序
未结束时报告 **死锁**。每步输出 **共享状态** 与 **持锁表**，并支持 **穷举 ≤20 步的全部调度**，
生成结果集合，再通过 **顺序参考（sequential reference）核验** 确认结果正确。

## 构建与测试

```bash
npm test          # 编译 (tsc) 并运行 node:test 测试
npm run build     # 仅编译到 dist/
```

## 程序格式（JSON）

```json
{
  "shared": { "x": 0 },
  "threads": [
    [ { "op": "read", "var": "x", "dst": "r" } ],
    [ { "op": "write", "var": "x", "src": 1 } ]
  ]
}
```

- `shared`：共享变量初始值（数值）；`threads`：1–3 个线程，每个线程是指令数组。
- 每个线程有独立的局部寄存器（未初始化的寄存器读作 0）。

### 指令集

| 指令 | 含义 |
| --- | --- |
| `{ "op": "set", "dst": "r", "value": 3 }` | 寄存器 `r` ← 常量 |
| `{ "op": "add", "dst": "r", "value": -1 }` | 寄存器 `r` += 常量 |
| `{ "op": "read", "var": "x", "dst": "r" }` | 寄存器 `r` ← 共享变量 `x` |
| `{ "op": "write", "var": "x", "src": "r" }` | 共享变量 `x` ← 常量或寄存器 |
| `{ "op": "lock", "mutex": "m" }` | 获取互斥锁（被他人持有则阻塞） |
| `{ "op": "unlock", "mutex": "m" }` | 释放互斥锁（非持有者报错） |
| `{ "op": "jnz", "reg": "r", "target": 1 }` | `r != 0` 则跳转到指令下标 `target` |

## CLI 用法

```bash
npm run build

# 按调度序列逐步推进（缺省为顺序参考调度），打印每步共享状态与持锁表
node dist/src/cli.js run examples/race.json --schedule 0,1,0,1,0,1

# 穷举 ≤20 步的全部调度，输出结果集合与死锁状态
node dist/src/cli.js explore examples/race.json
node dist/src/cli.js explore examples/deadlock.json --max-steps 8

# 顺序参考核验：重放所有终止调度、检查顺序参考结果属于结果集合、重复穷举验证确定性
node dist/src/cli.js verify examples/mutex.json

# 仅查看顺序参考执行（线程 0 跑完再跑线程 1……）
node dist/src/cli.js sequential examples/branch.json
```

`run` 的退出码：正常结束为 0，检测到死锁为 2。

## 语义要点

- **调度序列**：如 `0,1,0` 表示依次让线程 0、1、0 各执行一条指令；选中不可运行
  （阻塞/已结束）的线程会报“非法调度”。
- **死锁**：所有未结束线程都阻塞在 `lock` 上时，执行停止并输出死锁时的持锁表。
- **穷举**：对状态（PC、寄存器、共享内存、持锁表）去重做 DFS，步数上限 20
  （`maxSteps` 须在 1..20）；超出步数上限记为 `cutoff`，状态数超限记为 `truncated`。
- **核验**：① 用确定性单步器重放每条终止调度并比对终态；② 顺序参考执行的结果
  必须出现在穷举结果集合中（步数超出探索界时跳过）；③ 重复穷举应得到相同结果集。

## 目录结构

- `src/simulator.ts` — 指令集、程序校验、单步执行器、快照（共享状态 + 持锁表）
- `src/explore.ts` — ≤20 步调度穷举、结果集合、顺序参考与核验
- `src/cli.ts` — 命令行入口（run / explore / verify / sequential）
- `tests/` — `node:test` 测试（`npm test`）
- `examples/` — 竞态、互斥锁、死锁、分支循环四个示例程序
