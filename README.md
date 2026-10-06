# repsim — 联合共识成员切换复制模拟器

单 leader 复制日志模拟器，按 Raft 联合共识（joint consensus）实现安全成员变更。

## 成员切换流程

1. **联合配置**：`ChangeMembership(target)` 追加 joint 条目（Old+New）。
2. **双多数仲裁**：联合期间任何条目提交须同时获得旧集多数 **和** 新集多数
   （`Membership.QuorumSatisfied`）。未提交的新集不能单独推进，旧集亦然。
3. **最终配置**：joint 条目提交后 leader 自动追加 final 条目；其提交后
   仅由新集仲裁（`KindFinal` 条目安装仅含新集的成员配置）。
4. **幂等**：相同目标的重复配置事件（进行中或已完成）直接返回既有结果，
   不追加重复条目；冲突目标在进行中被拒绝。

## 提交仲裁证书

每次提交输出 `CommitCertificate`：仲裁所用的成员配置、投票者、
旧集多数与新集多数（仅联合期）。`Verify` 校验多数真实性；
`CheckTrace` 对整条故障轨迹检查安全不变式：

- 每条提交都有合法（联合期双多数）证书；
- 提交索引连续；
- 配置条目按 joint → final 顺序生效；
- final 提交后不得再沿用联合配置仲裁。

## 故障注入

`Crash` / `Recover` / `Isolate` / `Heal`，配合显式 `Tick()` 步进，
确定性复现分区与宕机轨迹。

## 运行测试

```sh
go test ./...
```
