# pack-quarantine

包装线隔离清单合成器：把视觉缺陷、条码和抽检结论合并成每个 case 的
`RELEASE` / `QUAR` / `CONFLICT` 状态，断电后可精确恢复到批次边界。
Node.js 22，仅标准库，测试使用 `node:test`。

## 用法

```sh
node bin/pack.js quarantine --in <dir> --out <dir>
# 或链接后： pack quarantine --in <dir> --out <dir>
```

输入目录中所有 `*.jsonl` 按文件名排序、行序即到达序。事件类型取
`type` 字段，否则取文件名（`vision|barcode|audit|retract`）：

- `vision`  `{eventTs, frame, sku, defect, hash, op}` — `defect: null` 表示干净检验
- `barcode` `{eventTs, frame, case, op}`
- `audit`   `{eventTs, sku, pass, op}`
- `retract` `{eventTs, kind|target, id}`（`id` 匹配被撤回事件的 `op`）

输出（写入 `--out`）：`cases.jsonl`、`release.json`、`wal.jsonl`、`late.log`。

## 语义

- 事件时间窗口：10s 滚动窗口，按 case 聚合 frame；vision(hash) 与 barcode
  只在同一窗口内按 frame 联结。
- 水位线 = 最大事件时间 - 3s；`eventTs < watermark` 的事件拒收并记入 `late.log`。
- 同一 case 出现跨 SKU → `CONFLICT`，任何情况下不得放行。
- 有未撤回缺陷证据 → `QUAR`；无缺陷且该 SKU 最新有效 audit 为 pass → `RELEASE`。
- `retract audit` 让已放行 case 回到 `QUAR`；`retract vision` 移除该事件的
  缺陷证据与 SKU 归属，审计链（audit 记录）不受影响。
- `hash` 必须是 64 位小写十六进制，否则报 `HASH_BAD`（退出码 1），且不产生任何状态。

## 崩溃恢复

故障点定义：写完 `outbox.tmp`（每个输出先写 `<name>.tmp` 并 fsync）尚未
rename 前崩溃。恢复流程：

1. 丢弃残留的 `*.tmp` 半条 outbox；
2. 重放 `wal.jsonl`（容忍末尾撕裂行）重建状态，跳过已应用的输入事件；
3. 继续处理剩余输入并重写输出。

恢复后状态与无故障运行完全一致（wal 字节级相同）。可用
`--crash before-rename|after-rename` 手工模拟故障点。

## 测试

```sh
node --test
```
