# alarm-manual-search

控制室离线报警手册检索库与 CLI。Node.js 22，仅标准库，单机离线。

## 功能

- 分词器产出 token 位置（全局递增）与段落边界（空行分段）；短语只允许同段连续命中。
- 词项词典：term -> posting 列表，按块压缩（块大小 8）。块头存 `maxDoc`（最大 docID）
  与 `posBase`（位置基数），载荷为 base64 varint（docID 差分、位置相对基数、段落号）。
  交集查询用 `seekDoc` 按块头跳过无需解码的块。
- 删除为墓碑（tombstone），立即参与查询过滤；`compact` 物理清除并重建词典。
- compact 签发证书：词项数、删除数、文档数、排序叶子的 Merkle 根哈希，
  并通过 `prevHash` 链接旧证书（旧证书可证历史）；`cert --verify` 校验链与当前状态。
- 排序：短语命中数降序 -> 最小跨度升序 -> docID 升序（全序，并列稳定）。
- 错误码：`E_TOKEN`（空词项/未知文档）、`E_SPAN`（非法 k）、`E_CERT`（证书校验失败）。

## CLI

```
node src/cli.js build <dir>
node src/cli.js index <dir> <docs.jsonl>     # 每行 {"id":"ALM-101","text":"..."}
node src/cli.js del <dir> <docID|extID...>
node src/cli.js compact <dir>
node src/cli.js query <dir> [--phrase "泵 气蚀"] [--near c01 a07] [--k 4] [--json]
node src/cli.js cert <dir> [--verify]
```

近邻语义：`--near A B --k N` 要求 A、B 同段且中间词数 <= N（k=0 即相邻）。

## 测试

```
node --test
```

覆盖：k=0/k=4/k=5 边界；与逐词枚举参考算法全查询对照（多种子语料 + 增删后）；
删除后 compact 证书变化且旧证书在链内可证历史；空词项 E_TOKEN、跨段短语不命中；
posting 块编解码往返与块跳过；CLI 端到端与错误码。
