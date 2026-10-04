# mirror — 定长块哈希树镜像库

仅使用 Go 标准库实现的内容同步/镜像库。

## 设计

- **定长块哈希树**（`tree.go`）：数据按 `BlockSize = 1024` 字节切块，
  以 `Fanout = 16` 构建 Merkle 树；叶数补齐到 16 的幂。
  叶哈希 `H(0x00 || data)`，内部节点 `H(0x02 || level || children...)`，域分离。
- **缺失叶 ≠ 全零叶**：缺失叶哈希为常量 `H(0x01)`，与全零块的
  `H(0x00 || 0…0)` 不同；读取缺失叶返回 `ErrMissing`，修复时在目标上删除该叶。
- **仅访问不同子树**（`sync.go: Diff`）：先比较根哈希，相等即返回；
  只在哈希不同的节点上递归，输出待修复叶索引（升序）。
- **修复发布不混合两个源版本**（`sync.go: Repair`）：修复开始时固定源版本号，
  全部待修复叶在该版本上读取并暂存，全部读完后才一次性发布到目标；
  读取期间源被修改则返回 `ErrVersionConflict`，目标一个字节都不会写。
- **可计数存储器**（`store.go: CountingKV`）：统计 Get/Put/Delete 次数并记录
  访问过的键，测试据此核对 Diff/Repair 的实际访问范围。
- **全量摘要**（`sync.go: Digest`）：顺序遍历全部叶位，存在叶与缺失叶分别
  编码后做 SHA-256，用于随机损坏修复后的整体一致性核对。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64。命令：`go test ./...`

```
ok  	mirror	0.549s
```

`go test ./... -v` 输出：

```
=== RUN   TestDiffVisitsOnlyDifferingSubtree
    mirror_test.go:67: diff node accesses: src=49 dst=49 (full tree has 4369 nodes)
--- PASS: TestDiffVisitsOnlyDifferingSubtree (0.27s)
=== RUN   TestMissingLeafDiffersFromZeroLeaf
--- PASS: TestMissingLeafDiffersFromZeroLeaf (0.00s)
=== RUN   TestRepairDoesNotMixSourceVersions
--- PASS: TestRepairDoesNotMixSourceVersions (0.01s)
=== RUN   TestRandomCorruptionFullDigest
--- PASS: TestRandomCorruptionFullDigest (0.30s)
=== RUN   TestBuildRoundTrip
--- PASS: TestBuildRoundTrip (0.00s)
PASS
ok  	mirror	0.583s
```

要点：4096 叶（共 4369 个节点）单块损坏时，Diff 每侧仅访问 49 个节点、
不读取任何叶数据；Repair 只读/写损坏的那 1 个叶。
