# 事件循环模拟器（event-loop-simulator）

确定性事件循环模拟器：分离维护**定时任务**（最小堆）与**微任务**（FIFO 队列），
每个宏任务后排空微任务、再取最早定时项；带**步数预算**，预算耗尽返回未闭合状态；
输出**可重放轨迹**，并用一套**独立队列模型**交叉核对。

纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 语义规则

1. 初始脚本 `main` 作为第一个宏任务执行；
2. 每个宏任务结束后，**排空微任务队列**——微任务可继续派生微任务，同一检查点内一并排空；
3. 然后选取**触发时间最早**的定时项作为下一个宏任务；时间相同按入队先后（FIFO）；
4. 虚拟时钟只在定时项出队时推进到其触发时间；
5. 每执行一个回调（宏/微）计 1 步；执行前检查预算，超出即返回
   `status: 'budget-exceeded'`，并在 `pending` 中报告剩余的定时项/微任务数量
   （未闭合状态）；全部排空则返回 `status: 'settled'`。

## 目录结构

```
src/simulator.ts   主实现：TimerHeap（二叉最小堆）+ MicroQueue（头索引 FIFO）+ run/replayTrace/formatTrace
src/model.ts       独立参照模型：数组线性扫描取最早定时项 + Array.shift，结构不同、不共享代码
src/examples.ts    6 个手写小例（含 2 个未闭合形态）
src/main.ts        示例 CLI：打印全部例子的轨迹时间线
test/              node:test 测试（手写期望 / 双实现交叉核对 / 预算语义）
types/             极简 node 模块类型声明（离线环境代替 @types/node）
```

## 运行

```bash
npm test        # tsc 编译 + node --test（需 tsc 在 PATH，TypeScript >= 5）
npm run examples # 打印 6 个手写例子的轨迹
```

## 轨迹与重放

`run()` 返回的 `trace` 为 `{step, phase, label, time}` 事件序列，可 JSON 序列化落盘；
`replayTrace(program, options, recorded)` 用同一程序与预算重新执行并校验轨迹、日志、
未闭合计数完全一致（测试中含 JSON 往返后再重放的用例）。

示例输出（`npm run examples` 实际结果）：

```
=== micro-inside-timer ===
#000 macro main @t=0
#001 macro t1 @t=5
#002 micro m @t=5
#003 macro t2 @t=10
status=settled steps=4 time=10 pending={timers:0, microtasks:0}

=== unclosed-microtask-loop ===
#000 macro main @t=0
#001..#006 micro spin @t=0
status=budget-exceeded steps=7 time=0 pending={timers:0, microtasks:1}
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出：

```
# Subtest: dist/test/budget.test.js
ok 1 - dist/test/budget.test.js
# Subtest: dist/test/crosscheck.test.js
ok 2 - dist/test/crosscheck.test.js
# Subtest: dist/test/examples.test.js
ok 3 - dist/test/examples.test.js
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# duration_ms ~380
```

逐文件子测试（直接 `node dist/test/<file>` 统计，共 20 个，全部通过）：

| 文件 | 子测试数 | 内容 |
| --- | --- | --- |
| `test/examples.test.ts` | 8 | 6 个手写例逐事件比对手工推导轨迹 + 覆盖率 + 格式化输出 |
| `test/budget.test.ts` | 7 | 预算边界（0/1/N-1/N）、未闭合 pending 计数、时钟推进、异常 |
| `test/crosscheck.test.ts` | 5 | 300 个随机 DAG 程序 + 100 个环型程序 + 全部手写例：主实现 vs 独立模型逐字段一致；轨迹重放与 JSON 往返 |

交叉核对中随机程序由确定性 PRNG（mulberry32）按种子生成，DAG 型保证可闭合、
环型保证不闭合，两类路径（settled / budget-exceeded）均被覆盖。

### 开发中发现并修复的问题（由交叉核对/手写例暴露）

1. 主实现微任务出队先于预算检查，预算耗尽时 `pending.microtasks` 少计 1；
2. 定时项 `pop` 先于预算检查，预算耗尽时 `pending.timers` 少计 1（两个实现同修）；
3. 测试生成器的 `main` 在运行期消费 PRNG，导致同一程序多次执行行为不同
   （不可重放）——改为生成期一次性确定全部效果，程序体保持纯函数。
