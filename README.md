# defect-recall

离线缺陷召回集生成工具：Node.js 22、仅标准库、`node:test`、单机离线。

## 功能

- **倒排索引**：CJK 单字 + 字母数字词元的位置索引，带字段位（描述/缺陷码/批次码）；
  缺陷码与批次码用删除邻域（deletion neighborhood）索引支持编辑距离 ≤1 的近邻检索。
- **召回集位图**：Roaring 风格位图（64K 分块，array/run/bitset 容器自适应压缩）。
- **增量删除批次**：倒排与位图源数据同步原地删除，无需重建。
- **证明证书**：`证书 = sha256(有序命中ID) + sha256(规范化查询) + 索引epoch`，
  并锚定到审计链上的 RECALL 事件哈希。
- **撤销召回**：`revoke` 把 epoch 恢复到该召回之前，但审计链只追加不篡改——
  召回与撤销都留在因果链上，任何删改都会被完整性校验发现。
- **审计链**：只追加的哈希链（每条含 prevHash），并做引用完整性校验
  （链必须覆盖当前 epoch 与所有召回/撤销记录，截断尾部也会被检出）。

## CLI

```bash
node cli.js [--store store.json] load <batch.json>        # 加载批次
node cli.js [--store store.json] load --delete <batchId>  # 增量删除批次
node cli.js [--store store.json] recall [--phrase P] [--defect-code C] [--batch-code C] [--name ID]
node cli.js [--store store.json] revoke <recallId>
node cli.js [--store store.json] prove <recallId>
node cli.js [--store store.json] audit
```

批次文件格式：`{"batchId":"B1","docs":[{"id","description","defectCode","batchCode"}]}`

- 同一规范化查询在同一索引状态下重复 `recall` 幂等：返回原召回，epoch 不变。
- `revoke` 仅当该召回之后没有其他操作（epoch 未推进）才允许，否则 `E_EPOCH`。

## 错误码与退出码

| 代码      | 含义                                   | 退出码 |
|-----------|----------------------------------------|--------|
| `E_EPOCH` | epoch 冲突（撤销时状态已推进、未知批次） | 2      |
| `E_DUP`   | 重复（批次/文档/召回名/重复撤销）        | 3      |
| `E_PROOF` | 证明或审计链校验失败                    | 4      |

## 测试

```bash
node --test          # 库与验收测试（位图、穷举查询比对、幂等、删除、撤销、篡改检测）
bash test/cli.e2e.sh # CLI 端到端测试（子进程方式，含退出码断言）
```
