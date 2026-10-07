# defect-recall

离线缺陷召回集生成器：Node.js 22、仅标准库、单机离线。

## 模型

- **倒排索引**：词项 → 字段位（desc=1 / code=2 / batch=4）→ 文档 → 位置列表。
  中文按重叠二元组（bigram）索引，免词典；字母数字码整词索引。
- **召回集**：Roaring 风格位图（高 16 位分桶，稀疏用有序数组、稠密转 bitset）。
- **查询规范化**：`{ phrase: [t1, t2], window }`（默认 `["裂纹","扩展"]`，window=4）。
  子句 A：desc 中 t2 在 t1 结束后 window 字符内出现（有序近邻短语）；
  子句 B：缺陷码 == t1 且批次码 == t2（同记录近邻）。
- **证书**：`hash(有序命中ID哈希 + 查询规范化哈希 + epoch + 索引状态哈希)`。
- **epoch**：load / delete-batch 递增；recall / revoke 不递增。每个 epoch 记录索引状态哈希。
- **撤销**：revoke 仅追加账本条目并标记召回记录为 revoked，原始条目与证书哈希
  保留在哈希链中，历史不可改写成"未发生"。同 epoch 再召回生成 `#v2` 版本。

## CLI

```sh
export RECALL_STATE=data/state.json   # 默认 ./data/state.json
node bin/recall.js load defects.json
node bin/recall.js recall --phrase 裂纹 扩展 [--window 4] [--force]
node bin/recall.js delete-batch B3
node bin/recall.js prove --cert cert.json [--at-epoch N]
node bin/recall.js revoke --phrase 裂纹 扩展 [--epoch N]
node bin/recall.js audit
```

错误码：`E_EPOCH`（epoch 不匹配 / 未知批次）、`E_DUP`（重复召回或重复撤销）、
`E_PROOF`（证书哈希、命中哈希或查询规范化哈希校验失败）。

## 测试

```sh
node --test
```
