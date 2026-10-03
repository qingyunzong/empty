# maint-scheduler

单机离线 Node.js 22 库与 CLI：设备周期维护事件 + 事件预留调度。全程使用
BigInt 精确有理数运算（`src/fraction.js`），无第三方依赖。

## 模型

- **周期规则**：`phase`、`period`、`duration` 为非负有理数（`period > 0`），
  可选抖动区间 `jitter = [jl, jh]`（有理数）。实例 `k` 的区间为
  `[phase + k*period, phase + k*period + duration)`。
- **预留**：有限区间 `[start, end)`（`end > start`）+ 整数 `priority`。
- 区间一律左闭右开：边界相等（如 `[0,1)` 与 `[1,2)`）不冲突。
- 实例在有限视窗 `[0, H]` 内枚举（起点落在 `[0, H)`）。

## 冲突判定

对每个活跃预留输出 `conflict` / `possible` / `none` / `overridden`：

- 无抖动：与某实例区间严格相交 → `conflict`。
- 有抖动 `[jl, jh]`：实例 `k` 起点为 `a`、时长 `d`，预留 `[s, e)` 时，
  冲突当且仅当抖动 `j ∈ (s-a-d, e-a)`。
  - `[jl,jh]` 完全落入该开区间 → `conflict`；
  - 交集非空但不完全包含 → `possible`，并给出边界证书
    （`boundary.lower = s-a-d`、`boundary.upper = e-a` 及实际冲突抖动子区间）；
  - 交集为空 → `none`。

## 事务与 undo/redo

`addRule` / `updateRule` / `addReservation` / `override` 均为事务：
出现分母为 0、`period <= 0`、`end <= start` 等校验失败时整体回滚并抛错。
每次成功提交进入 undo 栈，`undo()` / `redo()` 逐步回退/重做（含覆盖操作，
撤销覆盖后低优先级预留自动恢复活跃）。

## 覆盖

`override(highId, lowId, { permit: true })`：必须显式 `permit: true` 且
`high` 优先级严格大于 `low`。覆盖记录保存被覆盖 id 链（若 `low` 自身曾覆盖
其他预留，链会传递包含）。

## CLI

```sh
node cli.js spec.json     # 或 stdin: cat spec.json | node cli.js
```

输入：`{ "horizon": H, "ops": [...] }`，op 包括 `addRule` / `updateRule` /
`removeRule` / `addReservation` / `override` / `undo` / `redo` /
`enumerate` / `check` / `state`。输出为每个 op 的结果 JSON 数组，
失败 op 返回 `{ ok: false, error }` 且不中断后续 op。示例见 `examples/demo.json`。

有理数可写为整数、`"p/q"`、小数或 `{ "num": p, "den": q }`。

## 测试

```sh
node --test
```

真实运行结果（Node v22.22.1，2026-10-03）：

```
ok 1 - test/cli.test.js        (2 个子测试通过)
ok 2 - test/fraction.test.js   (4 个子测试通过)
ok 3 - test/scheduler.test.js  (8 个子测试通过)
# tests 3  # pass 3  # fail 0   （共 14 个子测试，全部通过）
```
