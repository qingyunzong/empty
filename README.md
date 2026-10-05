# mirror — 定长块哈希树镜像修复

仅用 Go 标准库实现的镜像库差分修复。

## 设计

- **定长块哈希树**（`merkle.go`）：仓库固定为 N 个 4096 字节块，叶数补齐到 2 的幂。
  三类哈希域分离：缺失叶 `0x00||index`、数据叶 `0x01||block`、内部节点 `0x02||L||R`，
  因此**缺失叶与全零叶哈希必然不同**，可明确区分。
- **差分**（`Diff`）：先比较根；根相同则零访问。仅对哈希不同的子树递归下探，
  输出待修复叶索引列表，相同子树完全不触碰。
- **修复发布**（`repair.go`）：修复前钉住源版本号，逐叶抓取后复核版本；
  源在修复期间一旦发生变更即返回 `ErrVersionSkew` 中止，
  **不会把两个源版本的块混入同一次发布**。
- **可计数存储器**（`CountingSource`）：记录每次块读取，输出访问索引集合与合并区间，
  用于核对修复只访问了差异叶。
- **全量摘要**（`Digest`）：覆盖全部叶（缺失/全零编码不同），修复后与源逐字节一致。

## 测试结果（实际输出）

`go test ./... -count=1 -v`，Go 1.27.1，linux/amd64：

```
=== RUN   TestRepairAccessesOnlyDifferingLeaves
--- PASS: TestRepairAccessesOnlyDifferingLeaves (0.04s)
=== RUN   TestCleanMirrorTriggersNoBlockReads
--- PASS: TestCleanMirrorTriggersNoBlockReads (0.01s)
=== RUN   TestMissingLeafDistinctFromZeroLeaf
=== RUN   TestMissingLeafDistinctFromZeroLeaf/both_missing
=== RUN   TestMissingLeafDistinctFromZeroLeaf/both_zero
=== RUN   TestMissingLeafDistinctFromZeroLeaf/dst_missing_src_zero
=== RUN   TestMissingLeafDistinctFromZeroLeaf/dst_zero_src_missing
--- PASS: TestMissingLeafDistinctFromZeroLeaf (0.00s)
    --- PASS: TestMissingLeafDistinctFromZeroLeaf/both_missing (0.00s)
    --- PASS: TestMissingLeafDistinctFromZeroLeaf/both_zero (0.00s)
    --- PASS: TestMissingLeafDistinctFromZeroLeaf/dst_missing_src_zero (0.00s)
    --- PASS: TestMissingLeafDistinctFromZeroLeaf/dst_zero_src_missing (0.00s)
=== RUN   TestRepairRejectsMixedSourceVersions
--- PASS: TestRepairRejectsMixedSourceVersions (0.00s)
=== RUN   TestFullDigestAfterRandomCorruption
--- PASS: TestFullDigestAfterRandomCorruption (0.31s)
PASS
ok  	mirror	0.367s
```

覆盖点：

- `TestRepairAccessesOnlyDifferingLeaves`：随机损坏 9 个叶（垃圾/全零/删除三种），
  断言源端访问集合与访问区间精确等于损坏集合，修复后全量摘要与根一致。
- `TestCleanMirrorTriggersNoBlockReads`：根相同 → 零块读取。
- `TestMissingLeafDistinctFromZeroLeaf`：缺失叶与全零叶哈希不同，四种组合差分行为正确。
- `TestRepairRejectsMixedSourceVersions`：修复中途源版本变更 → `ErrVersionSkew`，重修复后一致。
- `TestFullDigestAfterRandomCorruption`：20 轮随机规模（1–128 块）、随机缺失/全零源、
  随机损坏，修复后全量摘要与根全部一致，且访问集合精确等于差分叶集合。
