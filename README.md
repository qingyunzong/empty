# diffc

整数差分约束库：维护一组形如 `x - y <= c` 的约束，判定可行性并给出证书。

- `System.Add / Remove / Apply`：增删约束；`Apply` 批次修改原子生效（任一编辑非法则整批不变）。
- `Snapshot()`：返回不可变快照，旧快照在系统后续修改后仍可读、可求解、可验证。
- `Undo()`：撤销最近一次增删或批次修改，恢复旧状态，旧证书重新生效。
- `Snapshot.Solve()`：Bellman-Ford（虚拟零权源），返回 `Certificate`：
  - 可行：`Potentials`（每个变量的势能，满足全部约束）；
  - 不可行：`Cycle`（构成负环的约束 ID 序列，首尾相接）。
- `Snapshot.Verify / VerifyPotentials / VerifyCycle`：独立校验证书。

仅使用 Go 标准库。测试包含小图全路径暴力模型交叉核对（枚举所有简单路径与简单环）。

## 测试

```sh
go test ./...
```
