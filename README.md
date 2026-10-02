# maint-sched

设备周期维护与事件预留库与 CLI（Node.js 22，单机离线，零依赖）。

## 模型

- **周期规则** `{ id, phase, period, duration, jitter? }`：均为非负有理分数（`"p/q"`、整数或 `{num,den}`），`period > 0`；`jitter` 为可选 `[jl, jh]` 有理抖动区间（默认 `[0,0]`）。
- **预留** `{ id, start, end, priority?, permit? }`：有限区间 `[start, end)`，`end > start`。
- 区间为左闭右开 `[start, end)`，边界相等不冲突；实例在视窗 `[0, H]` 内枚举：`start = phase + k*period < H`。

## 冲突判定

实例 `[s, s+d)` 在抖动 `j ∈ [jl, jh]` 下与预留 `[r, e)` 冲突 ⟺ `j ∈ (r-s-d, e-s)`：

- `conflict`：整个 `[jl, jh]` 都在冲突窗口内（确定冲突）；
- `possible`：交集非空但未全覆盖，输出边界证书（冲突窗口、交集、冲突/不冲突抖动见证点）；
- `none`：交集为空。

## 事务与覆盖

- `addRule` / `updateRule` / `addReservation` / `transaction(label, fn)` 均为事务：分母为 0、`period<=0`、`end<=start` 等校验失败即回滚；提交后支持 `undo()` / `redo()`。
- 高优先级预留带 `permit: true` 时覆盖冲突的低优先级预留，被覆盖 id 链记录于 `overrides`（`overrideChain(id)` 给出传递闭包）；undo 后低优先级预留恢复。

## CLI

```sh
node cli.js input.json        # 或省略文件参数从 stdin 读取
```

输入：`{ "H": "10", "commands": [...] }`，命令：`addRule`、`updateRule`、`addReservation`、`enumerate`、`check`、`checkAll`、`overrideChain`、`undo`、`redo`、`reservation`。输出为每条命令一个结果的 JSON 数组。

## 测试

```sh
node --test
```
