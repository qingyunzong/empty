# imgdiff — 镜像比较与搬迁计划工具

仅使用 Go 标准库。比较两个稀疏镜像的区间清单，输出内容差与布局差的
最大半开区间；并能生成把旧镜像改写为新镜像的搬迁计划。

## 清单格式（manifest）

```json
{
  "size": 65536,
  "parent": { "...": "可选，父快照清单，递归" },
  "extents": [
    {"start": 0,     "end": 4096, "kind": "data", "digest": "<内容标识>"},
    {"start": 4096,  "end": 8192, "kind": "data", "digest": "...", "zero": true},
    {"start": 8192,  "end": 12288, "kind": "hole"}
  ]
}
```

- 区间为半开 `[start, end)`，偏移为无符号 64 位；`end > size`、
  `end <= start`、区间重叠一律拒绝。
- 未列出的区域为洞；**洞读取为零**。
- `zero: true` 的数据块（零数据块）与洞**内容相等但布局不同**。
- `digest` 是不透明内容标识；跨镜像比较时应按统一粒度计算
  （如每块一个摘要）。
- 子清单的区间覆盖父快照对应范围，未覆盖区域继承父快照（可递归）。

## 比较

```
imgdiff diff old.json new.json
```

输出内容差与布局差的最大半开区间（相邻差异段已合并）：

```json
{
  "content": [{"start": 4096, "end": 8192}],
  "layout":  [{"start": 4096, "end": 8192}, {"start": 16384, "end": 20480}]
}
```

- 内容差：按逻辑字节比较（洞按零计；零数据块与洞内容相等）。
- 布局差：洞与数据块不一致，或数据块内容标识不一致；内容差是布局
  差的子集。零数据块 vs 洞只出现在布局差中。

## 搬迁计划

```
imgdiff plan -block 4096 old.json new.json
```

要求两镜像等大、大小为块大小的整数倍、区间边界按块对齐。输出步骤
序列（`save` / `copy` / `restore` / `zero` / `punch` / `write`）：

- 源与目标范围可任意重叠；循环搬迁用**至多一块**暂存（`save` 存入
  暂存块、读者改为 `restore`）打破，绝不允许覆盖尚未保全的来源。
- 每步先保全仍会被读取的旧数据，再覆盖；所有步骤幂等，任一步中断
  后可根据日志（已完成步数）续行，重做当前步骤亦安全。
- 新内容若不在旧镜像中，由 `write` 步骤按 digest 从外部取数。

`VerifyPlan` 独立核对计划：符号化模拟每步，检查不覆盖仍被读取的来
源、暂存块不超限，并要求最终内容与洞布局与新镜像完全一致。
`Executor` 在 `Disk`（字节数组 + 洞位图）上执行计划，`State`（磁
盘、暂存块、日志）为崩溃后可恢复的持久状态。

## 测试

测试用小字节数组独立核对：逐字节朴素比较验证差异语义（逐字节摘要
时），O(n²) 暴力分段验证多字节区间的扫描逻辑；随机迁移 + 循环搬
迁 + 每步后崩溃续行/重做均核对最终内容与洞布局。

实际运行结果（Go 1.27.1，linux/amd64，`go test ./...`）：

```
ok  	imgdiff/cmd/imgdiff	0.032s
ok  	imgdiff/imgdiff	0.132s
```

共 18 个测试全部通过，包括：

- `TestDiffAgainstByteArrays` / `TestDiffSweepAgainstBruteForce` —
  小字节数组独立核对内容差与布局差；
- `TestDiffZeroBlockVsHole` — 零数据块与洞内容相等、布局不同；
- `TestBoundsRejected` — 区间越界/重叠/空区间拒绝；
- `TestParentInheritance` / `TestParentClippedToChildSize` — 父快
  照共享区间；
- `TestUint64Offsets` — 接近 2^64 的无符号 64 位偏移；
- `TestPlanRandomMigrations` — 随机迁移：计划核对 + 执行 + 每步崩
  溃续行 + 步骤重做幂等；
- `TestPlanRotationCycle` / `TestPlanSwapCycle` /
  `TestPlanOverlappingShift` — 循环与重叠搬迁；
- `TestVerifyPlanRejectsUnsavedOverwrite` — 覆盖未保存来源、第二块
  暂存、最终状态不符均被拒绝。
