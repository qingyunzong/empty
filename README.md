# perm

权限库：把授予（Grant）、撤销（Revoke）及临时例外（Exception）事件历史
转换为每个动作的有效半开区间 `[Start, End)`，末段开放（`End == Inf`）。

## 语义

- 事件排序：先按 `Tick`，同 tick 按 `Version`；同 tick 同 version 时撤销优先
  （Revoke 后生效，压过 Grant）。
- Grant/Revoke 设定基态；Exception 在 `[Tick, Until)` 窗口内临时覆盖基态，
  Deny 例外优先于 Allow 例外（撤销优先）。
- 授权链只含决定性事件：最近一次改变基态的 Grant/Revoke（冗余的重复
  授予/撤销被跳过），加上真正翻转结果的例外。相邻决策与链相同的段合并。
- `Query(action, tick)` 返回决策与完整授权链；`Correct(id, e)` 更正历史
  事件（保留 ID，调用方递增 Version）后区间模型即时重建。

## 验证

`go test ./...`：单元测试覆盖边界、同 tick 版本序、撤销优先、例外窗口、
历史更正与相邻合并；`model_test.go` 用独立的逐 tick 增量状态机对随机事件
序列（含历史更正）逐 tick 交叉核对区间模型，并校验半开、连续、开放末段
与相邻合并不变量。
