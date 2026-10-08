# por-checker

一个针对“共享整数 + 多线程”小型程序的交错枚举与压缩验证器。
输入程序经 CLI 校验（**至多 3 个线程、每线程至多 8 条指令**，指令仅
`read` / `write` / `lock` / `unlock` / `assert`），随后：

1. **不压缩探索**：DFS 枚举所有指令级交错，找出断言失败 / 死锁 / 非法 unlock；
2. **独立操作交换压缩**：read/assert 为纯读操作，不同线程的相邻纯读步可交换
   （Mazurkiewicz 迹等价）。探索端用 sleep-set 偏序归约，每类等价迹只探索一个
   代表；错误历史再经相邻独立步交换归一化后去重；
3. 输出**最短错误历史**（程序无循环，状态空间无环，到达任一状态的路径长度由
   pc 向量唯一确定，因此压缩与否得到的最短错误长度必然一致——测试对此做了对照）。

仅使用 TypeScript + Node.js 内置模块（`node:fs`、`node:test`、`node:assert` 等），
无任何 npm 运行时/开发依赖（`src/node-shims.d.ts` 提供最小类型声明）。

## 输入语言

```
shared x = 0          # 共享整数及其初值（必须且只能出现一次，位于线程之前）
thread t0             # 线程块，至多 3 个
  read r1             # r1 := x        （寄存器 r1..r4，线程私有，初值 0）
  write r1 + 1        # x := <expr>    （expr = 整数 | x | rN，可 +/- 整数）
  lock                # 互斥锁；被占用（含自己持有）时阻塞
  unlock              # 释放锁；未持有锁时构成运行错误
  assert x == r1 + 1  # 比较符 == != < <= > >=；不成立则该执行失败
```

校验规则：1–3 个线程、每线程 1–8 条指令、未知指令报行号、
`shared` 声明缺失/重复/位置错误均拒绝（退出码 2）。

## 使用

```sh
npm test                              # 编译 + 运行全部测试（node:test）
npm run check -- examples/race.txt    # 对单个程序做对照检查
node dist/src/cli.js examples/race.txt --max-visited 1000000
```

退出码：0 = 未发现错误；1 = 找到错误历史；2 = 输入非法。

## 实际运行结果（npm test 通过：15/15）

`node dist/src/cli.js examples/<name>.txt` 实测输出（visited = DFS 访问节点数，
executions = 完整执行数，errors = 失败执行数 / 压缩后的等价类数）：

| 示例 | full visited | full exec | full errors | por visited | por exec | por errors | 最短错误（两者一致） |
|---|---|---|---|---|---|---|---|
| `race.txt`（无锁自增 + 断言） | 63 | 20 | 4 | 36 | 9 | 3 | 5 步 |
| `mutex.txt`（加锁自增） | 21 | 2 | 0 | 21 | 2 | 0 | 无错误 |
| `reads.txt`（3 线程纯读） | 5248 | 1680 | 0 | 64 | 1 | 0 | 无错误 |
| `deadlock.txt`（重复加锁） | 2 | 1 | 1 | 2 | 1 | 1 | 1 步 |
| `bad-unlock.txt`（未持锁解锁） | 1 | 1 | 1 | 1 | 1 | 1 | 1 步 |

`race.txt` 的最短错误历史（5 步，丢失更新）：

```
 1. t0#0 read r1            (x=0)
 2. t0#1 write r1 + 1       (x=1)
 3. t1#0 read r1            (x=1)
 4. t1#1 write r1 + 1       (x=2)
 5. t0#2 assert x == r1 + 1 (x=2)
 => assertion failed (2 == 1 is false)
```

`reads.txt` 的对照最能体现压缩效果：3 线程 × 3 条 read 共
`9!/(3!·3!·3!) = 1680` 种交错，全部等价，压缩后仅探索 1 条执行（64 个节点）。

## 代码结构

- `src/lang.ts` — DSL 类型、解析器、3 线程 / 8 指令上限校验、格式化
- `src/sem.ts` — 状态与单步语义、独立性关系（仅 read/assert 之间独立）
- `src/explore.ts` — 完整枚举 `exploreFull`、sleep-set 压缩 `explorePor`、
  迹归一化 `canonicalOrder` / `canonicalKey`
- `src/cli.ts` — 命令行入口（解析 → 校验 → 双模式对照 → 打印最短错误历史）
- `test/checker.test.ts` — 15 个测试：输入校验、小例上压缩/不压缩对照
  （最短长度一致、verdict 一致、压缩不增加探索量）、CLI 端到端
- `examples/` — 上表中的 5 个示例程序
