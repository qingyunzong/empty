# 测试结果记录

环境：go1.27.1 linux/amd64，仅使用 Go 标准库。

## `go test ./...`

```
ok  	rolelib	0.334s
```

## `go test -v ./...`（15 个测试全部通过）

```
--- PASS: TestDifferentialWithFullClosureModel (0.36s)   # 全闭包模型差分对照：60 种子 × 400 随机操作
--- PASS: TestInheritanceTransitive (0.00s)              # 继承传递闭包
--- PASS: TestSSDDirectConflict (0.00s)                  # SSD 直接冲突拒绝
--- PASS: TestSSDIndirectConflictChain (0.00s)           # SSD 继承间接冲突 + 最短链
--- PASS: TestShortestChainSelected (0.00s)              # 多条继承路径取最短链
--- PASS: TestGrantBatchAtomic (0.00s)                   # 批授予原子性（对外/内部冲突）
--- PASS: TestDSDSeparateFromSSD (0.00s)                 # DSD 与 SSD 分别检查
--- PASS: TestDSDIndirectConflictChain (0.00s)           # DSD 继承间接冲突 + 最短链
--- PASS: TestCycleDetection (0.00s)                     # 继承环检测
--- PASS: TestAddInheritanceCreatingConflictRejected (0.00s) # 新增继承边引入冲突被拒绝并回滚
--- PASS: TestAddConstraintWhenViolatedRejected (0.00s)  # 新增约束与现状冲突被拒绝并回滚
--- PASS: TestRevokePrunesSession (0.00s)                # 撤销授予联动失活
--- PASS: TestRemoveInheritance (0.00s)                  # 删除继承边联动收缩
--- PASS: TestActivateNotGranted (0.00s)                 # 激活未持有角色被拒绝
--- PASS: TestSelfExclusionRejected (0.00s)              # 自排斥约束被拒绝
PASS
ok  	rolelib	0.364s
```

## 附加验证

- `go vet ./...`：通过。
- `go test -race -count=3 ./...`：`ok  rolelib  4.417s`。
- 差分对照曾暴露一处真实缺陷：`revalidate` 原先按 map 序返回首个冲突，
  未取全局最短冲突链；已修复为跨用户/会话选总链长最短者（见 git 历史）。
