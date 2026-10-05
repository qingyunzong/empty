# bitemp — 双时态版本查询库

仅使用 Go 标准库。

## 模型

- **更正记录（Correction）**：按提交（commit）分组追加。每条更正覆盖业务时间
  半开区间 `[ValidFrom, ValidTo)`，携带值或删除标记。
- **提交时间轴**：commit 时间必须非递减；历史永不改写——新更正只对提交时间
  不早于其所属 commit 的查询可见。同一 commit 内的更正按顺序生效，后者覆盖前者。
- **删除也是更正**：删除带有自己的业务时间有效区间，只在该区间内、且在该
  删除提交之后生效；区间外的值与提交前的历史均保留。
- **查询**：`Query(key, validTime, commitTime)` 在两个时间轴上定位，返回
  `(value, commitID, ok)`，其中 `commitID` 是该值的来源提交 ID。

## 实现

`bitemp/store.go`：段（segment）只追加不修改，查询时在覆盖 `validTime` 且
`commitSeq <= commitSeqAt(commitTime)` 的段中取修订号最大者。

## 验证

`bitemp/store_test.go` 中的 `TestRandomizedAgainstNaiveGrid` 用 8 个固定种子
生成随机提交序列，与朴素二维网格模型（每次提交后快照全量状态，按
`[key][commitSeq][validTime]` 网格查询）逐点对照，包括来源提交 ID。

## 测试结果（实际运行记录）

```
$ go test ./... -count=1
ok  	bitemp/bitemp	0.018s
```

环境：go1.27.1 linux/amd64，2026-10-05。全部 7 个测试（含 8 个随机种子子测试）通过。
