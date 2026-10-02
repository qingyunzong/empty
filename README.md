# custody-chain

生物样本保管链（chain of custody）审计日志：append-only 哈希链 + Merkle 证明 +
原子快照。纯 Node.js 22 标准库，无第三方依赖。

## 存储布局（`--store DIR`）

- `events.jsonl` — 每行一个事件，append-only，每次写入后 fsync
- `manifest.json` — 快照清单，原子发布（tmp + fsync + rename + 目录 fsync）
- `manifest.json.tmp` — 发布中的快照；恢复时忽略并清除

## 事件模型

事件类型：`receive` / `transfer` / `analyze` / `destroy` / `revoke`。
每个事件携带 `seq`、`ts`、`actor`、`sampleId`、`consentId`、`reason`、`payload`、
`prevHash`、`hash`；`hash = sha256(canonicalJSON(除 hash 外的全部字段))`，
`prevHash` 链接前一事件（首事件为 64 个 `0`）。

撤销同意是 tombstone 事件：`revoke` 追加后，任何依赖该 `consentId` 的新事件
被拒绝（`REVOKED_CONSENT`）；撤销前的历史事件保留在日志中，在 `verify`/`list`
输出里标记为 `restricted`——事实不可抹除，只是受限。

## CLI

```sh
node bin/cli.js event     --store DIR --type receive --consent C1 --sample S1 --actor alice [--payload JSON]
node bin/cli.js revoke    --store DIR --consent C1 --reason "donor withdrew" [--actor bob]
node bin/cli.js challenge --store DIR [--index N]     # 省略 index 时随机选叶
node bin/cli.js verify    --store DIR [--proof FILE]  # 离线重算全链 + manifest + 可选证明
node bin/cli.js snapshot  --store DIR                 # 原子写 manifest
node bin/cli.js list      --store DIR                 # 列出事件及 restricted 标记
```

错误以 `ERROR <CODE>: ...` 打到 stderr，退出码 1：
`BROKEN_CHAIN`（链/manifest 不一致，details 含 `seq` 定位）、
`REVOKED_CONSENT`、`NO_PROOF`（空链或越界索引）。

## 崩溃恢复

- 快照：tmp 文件 + fsync + rename + 目录 fsync。崩溃只可能留下旧 manifest
  或新 manifest，恢复时清除残留 tmp，绝不存在半快照。
- 事件追加：每行 fsync；恢复时截断末尾撕裂行（无换行符的不完整记录）。
- 打开存储时全量重放校验哈希链，并校验 manifest 与日志前缀一致
  （`headHash`、`merkleRoot`、`leafCount`），不一致即 `BROKEN_CHAIN`。

## 测试

```sh
node --test
```
