# Bilateral Net Settlement + Compressed Positional Index

Node.js 22 标准库实现，单机离线，无第三方依赖。

## 模块

- `src/varint.js` — LEB128 varint 与 delta 编码，用于压缩位置倒排表。
- `src/index.js` — `PositionalIndex`:分段压缩位置索引。
  - 删除先写墓碑（tombstone)，段内死位置比例超过 `compactThreshold` 时压缩重写为新段。
  - `phrase(q)` 短语查询、`near(a, b, k)` 近邻查询（最短命中窗口，并列取 id 最小者）。
  - 查询返回证书 `{segments, hash}`：使用了哪些压缩段 + 结果哈希。
  - 段与 manifest 落盘（tmp+rename 原子替换），可重启恢复。
- `src/ledger.js` — `Ledger`:交易 `id/buyer/seller/amount/desc/state`。
  - 撤销/删除/新增后按买卖双方重算所有存活交易的净额、方向与保证金冻结额。
  - 净额反转时「释放原冻结 + 按新方向冻结」在同一个原子批次（先校验全部操作再整体应用，记入同一 journal 条目）。
  - 错误码：`UNKNOWN_TRADE` / `DUPLICATE_DELETE` / `INVALID_AMOUNT` / `NOT_LIVE` / `DUPLICATE_TRADE`，出错时无任何状态变化。
- `src/system.js` — `SettlementSystem`：账本 + 索引组合，共享数据目录。
- `src/cli.js` — 命令行入口（也可 `require` 后调用 `run(argv)` 进程内使用）。

## CLI

```sh
node src/cli.js --data DIR add --id t1 --buyer A --seller B --amount 100 --desc "alice pays bob"
node src/cli.js --data DIR revoke --id t1
node src/cli.js --data DIR delete --id t1
node src/cli.js --data DIR net --a A --b B
node src/cli.js --data DIR phrase --q "pays bob"
node src/cli.js --data DIR near --x pays --y bob --k 3
node src/cli.js --data DIR compact
node src/cli.js --data DIR stats
node src/cli.js --data DIR hash
```

## 测试

```sh
node --test
```
