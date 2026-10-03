# settlement-audit

离线可验证的结算审计库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。不依赖网络或密钥服务。

## 设计

- **MVCC 存储**：每笔支付 / 结算 / 撤销提交为一个新版本，旧版本快照（`state/vNNNNNN.json`）永不修改或删除。
- **证书链**：提交成功返回证书 `{version, parentVersion, snapshotVersion, opHash, prevCertHash, digest}`。
  `opHash` 为规范化（键排序、无空白）操作记录的 SHA-256；`digest` 为证书前五项规范化后的 SHA-256；`prevCertHash` 链接前一证书，形成防篡改链。
- **WAL**：`wal.log` 逐条追加（JSON Lines，写入后 fsync），先于状态落盘。
- **撤销即反向分录**：支付撤销生成同对手方负金额分录；结算撤销生成反向资金流分录；原交易仅标记 `reversed`。
- **二级索引**：`index/<party>.json` 按交易对手记录条目，支持 `--at` 版本的 as-of 查询。
- **并发控制**：提交经 `lock` 文件（`O_EXCL`）串行化；冲突（重复撤销、重复 txId）返回 `E_CONFLICT`，失败提交不产生版本，证书链保持连续。

## CLI

```sh
node src/cli.js commit --data DIR --type payment    --party alice --amount 100 [--tx-id ID]
node src/cli.js commit --data DIR --type settlement --from alice --to bob --amount 25
node src/cli.js commit --data DIR --type reversal   --reverses tx-1
node src/cli.js get     --data DIR --at 2
node src/cli.js audit   --data DIR --party alice [--at 2]
node src/cli.js verify  --data DIR          # 失败时输出 E_TAMPER 及首个不匹配 seq，退出码 1
node src/cli.js tamper-test --data DIR      # 复制目录、改写 WAL 金额、验证副本应得 E_TAMPER
```

`verify` 从 WAL 重放全部操作，独立重算 `opHash` 与证书 `digest` 链，并逐版本比对磁盘快照与 `head.json`。

## 错误码

`E_INVALID` 参数非法 · `E_NOT_FOUND` 目标不存在 · `E_CONFLICT` 并发/状态冲突 · `E_TAMPER` 篡改（含首个不匹配序号）· `E_LOCKED` 锁超时

## 测试

```sh
node --test
```

覆盖：三笔业务后 verify 通过与 as-of 快照可见性；并发撤销同一交易一成一败（`E_CONFLICT`）且链连续；复制数据目录改写 WAL 金额后 `E_TAMPER` 定位首个不匹配序号；参考测试独立实现规范化与哈希重算，对照 WAL 中全部证书。
