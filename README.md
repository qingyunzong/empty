# qcert — 离线质量证书段式存储与可验证证明

Node.js 22，仅标准库，单机离线，无密钥、无网络。第三方仅凭哈希即可验证包含/排除证明。

## 存储模型

- 证书按段存储：`segments/<id>.seg`，二进制格式 `QSEG | header | text | 词元位置索引(差分 varint 压缩) | sha256 校验和`。
- `manifest.json`：元素有序列表（`seg` / `tomb`），每个元素折入哈希链 `head = sha256(head_prev || elemHash)`，起源为 `sha256("QCERT/GENESIS")`。
- 删除：段文件移入 `archive/`，链上原位替换为墓碑 `{pred, succ, hash, epoch}`，epoch 单调递增。
- `journal.log`：每次提交的 manifest 快照，用于历史 epoch 的包含证明。
- 提交协议：写段 → fsync → 写 `manifest.tmp` → fsync → 原子 rename → 追加 journal。

## 故障与恢复

故障注入点（`QCERT_FAULT`）：`seg`（段撕写）、`pre-manifest`（段完整但 manifest 未写）、`replace`（tmp 已写未 rename）。
`recover` 只承认最后完整链：链校验失败（`E_CHAIN`）时不做任何状态迁移；否则丢弃残留 `manifest.tmp`，把未被 manifest 引用的段（撕写 `torn` / 孤儿 `orphan`）移入 `quarantine/`，不参与查询。

## CLI

```
node cli.js put     --data DIR [--id ID] [--text T | --file F]
node cli.js del     --data DIR --id ID
node cli.js query   --data DIR --phrase "复验 合格"
node cli.js prove   --data DIR --id ID        # 存活→包含证明；已删→排除+历史包含证明
node cli.js recover --data DIR
node cli.js verify  --proof FILE [--phrase "复验 合格"]   # 第三方验证
```

错误码：`E_CHAIN`（链/哈希不符）、`E_TORN`（段撕写）、`E_ABSENT`（目标不存在）。

## 测试

```
node --test
```
