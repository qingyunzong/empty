# dyn-event-slicer

动态事件切片库：面向带读写状态单元的事件轨迹，查询某输出所依赖的最小动态事件切片，删除非切片事件后回放核对输出。纯 TypeScript + Node.js 内置模块（`node:test` / `node:assert`），零运行时依赖。

## 事件模型（`src/model.ts`）

每个事件是一个读写状态单元：

- `reads` / `writes`：读、写的状态变量集合；
- `kind: 'assign'`：`apply(state)` 由当前状态算出写入值；
- `kind: 'branch'`：`decide(state)` 产出布尔判定，其他事件经 `controlDeps: [{on, when}]` 受其控制——仅当分支回放判定等于 `when` 时被控事件才执行；
- `validateTrace` 校验轨迹合法性（id 连续、控制边指向更早的分支事件等）。

## 切片（`src/slice.ts`）

`dynamicSlice(trace, {event, var})` 以「事件 `event` 执行后变量 `var` 的值」为判据，自最后写者播种，沿数据依赖（读变量的最后写者）与控制依赖（`controlDeps`）做闭包：

- **覆盖写去掉已无贡献旧事件**：只追踪最后写者，被后续写覆盖且不再被读的旧写事件不进切片；
- **控制依赖保留**：被控事件所属分支及其自身依赖一律保留；
- 判据之后的事件与无关事件自动排除。

## 回放核对（`src/replay.ts`、`src/verify.ts`）

- `replay(trace, keep, initial, watch)`：仅回放 `keep` 中的事件（`null` 表示全量），被删分支的被控事件自动跳过，返回判据观测值；
- `verifySliceReplay`：删除非切片事件后回放，核对判据输出与全量轨迹一致；
- `checkMinimality`：`|S| <= 12` 时穷举全部真子集（`2^|S| - 1` 个）逐一回放，确认任何真子集都无法复现输出；更大切片退化为逐事件单删检查。

## 验收（`test/exhaustive.test.ts`）

确定性种子生成器（`src/gen.ts`，mulberry32）产出至多 20 事件的轨迹（赋值 / 分支 / 控制依赖混合），对每个判据（每个事件每个写变量 + 末事件全部变量）做「切片 → 删除 → 回放核对 → 子集穷举」。

## 运行

```sh
npm test    # tsc 编译 + node --test
```

## 实测结果（Node v22.22.1，tsc 7.0.2）

```
traces:              60 (sizes 1..20)
criteria:            697
replay checks:       697 (full trace vs deleted trace)
subsets replayed:    75327
exhaustive slices:   654 (all proper subsets, |S| <= 12)
single-removal:      3 (|S| > 12)
slice size avg/max:  3.52 / 14
failures:            0
# tests 2  # pass 2  # fail 0
```

调试过程中验收套件实际抓到并修复了一个生成器缺陷：`Object.assign` 无法写入 `Map`，导致生成期状态从未更新、记录的分支判定与回放不一致；修复后 697 个判据、75327 个子集回放全部通过。
