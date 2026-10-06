# Thread Schedule Simulator

TypeScript 编写的多线程程序模拟器：支持 ≤3 个线程的共享内存读写、互斥锁与条件分支，
按输入调度序列逐步推进；当没有可运行线程且程序未结束时报告死锁。可穷举 ≤20 步的
所有调度并生成结果集合，并以顺序执行（T0→T1→T2）作为参考进行核验。

## 指令集

| 指令 | 含义 |
| --- | --- |
| `{op:"read", shared, into}` | 读共享变量到线程局部变量 |
| `{op:"write", shared, from}` | 写共享变量（`from` 为常量或 `{local}`） |
| `{op:"add", local, value}` | 局部变量加常量 |
| `{op:"lock", lock}` / `{op:"unlock", lock}` | 获取/释放互斥锁（被他人持有则阻塞） |
| `{op:"branch", cond, then, else}` | 按局部变量条件跳转到指令下标 |

## 结果状态

- `finished`：全部线程执行完毕
- `deadlock`：存在未结束线程但没有任何可运行线程
- `incomplete`：调度序列（或步数上限）用完但仍有可运行线程

每次输出包含共享状态 `shared` 与持锁表 `locks`（锁名 → 持有者线程号或 `null`）。

## 使用

```bash
npm test          # 编译并运行全部测试
npm run demo      # 运行 examples/ 下的竞态与死锁示例
node dist/src/cli.js examples/race.json   # 单步跟踪 + 穷举 + 顺序核验
```

场景文件格式见 `examples/*.json`：`threads` 为各线程指令序列，`schedule` 为线程号序列，
`maxSteps` 控制穷举步数上限（默认 20）。

## API

- `new Simulator(programs, initialShared)`：`step(t)` 单步、`run(schedule)` 按序列执行、
  `status()` / `result()` 查询状态与结果。
- `enumerateSchedules(programs, initialShared, maxSteps)`：DFS 穷举所有交织调度，
  返回去重后的结果集合。
- `runSequential(...)` / `verifySequential(...)`：顺序参考执行，并核验其结果是否
  包含在穷举结果集合中。
