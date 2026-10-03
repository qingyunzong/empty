# pack-quarantine

包装线隔离清单合成器：把视觉缺陷、条码和抽检结论合并成按 case 的隔离/放行判定，
并保证断电后可精确恢复到批次边界。Node.js 22，仅标准库，单机离线。

## 用法

```sh
node bin/pack.js quarantine --in <dir> --out <dir>
# 或 npm link 后: pack quarantine --in <dir> --out <dir>
```

输入目录含 `events.jsonl`（缺省时读取目录下全部 `*.jsonl`，按文件名排序），每行一个事件：

```json
{"type":"vision","eventTs":1000,"frame":"f1","sku":"skuA","defect":"scratch","hash":"<64位小写hex>","op":"add"}
{"type":"barcode","eventTs":1001,"frame":"f1","case":"c1","op":"add"}
{"type":"audit","eventTs":1002,"sku":"skuA","pass":true,"op":"add"}
{"type":"retract","eventTs":1003,"kind":"vision|barcode|audit","id":"f1"}
```

- `vision.defect` 为 `null` 表示干净扫描（仍提供 sku 与 hash）。
- `retract` 的 `id`：vision/barcode 对应 frame，audit 对应 sku。

输出目录：

- `cases.jsonl` — 每行一个 case：`{case,status,skus,frames,defects,error?,reasons?}`
- `release.json` — 放行/隔离/冲突清单、水位线、错误列表、审计链
- `wal.jsonl` — 预写日志（每条事件 fsync 后才产生任何输出）
- `late.log` — 早于水位线（最大事件时间 − 3 秒）而被丢弃的事件

## 语义

- **水位线** = 已见最大 eventTs − 3000ms；eventTs 早于水位线的事件进 `late.log`，不影响状态。
- **联结**：barcode 把 frame 绑定到 case；vision 的 hash/defect 经 frame 汇入同一 case 窗口。
- **状态机**：同一 case 出现 ≥2 个 SKU → `CONFLICT`（永不可放行）；否则存在有效缺陷证据、
  `HASH_BAD` 或缺少有效 audit pass → `QUAR`；全部满足 → `RELEASED`。
- **撤回**：`retract/audit` 使已放行 case 回滚到 `QUAR`；`retract/vision` 移除该 frame 的
  缺陷证据（含 HASH_BAD 标记）但审计链完整保留；`retract/barcode` 解除 frame→case 绑定。
- **HASH_BAD**：hash 不是 64 位小写十六进制时，case 记 `error:"HASH_BAD"` 并隔离，
  同时写入 `release.json` 的 `errors` 与 stderr。

## 崩溃恢复

故障点定义为：写完 `outbox.tmp` 尚未物化（rename）为正式输出前崩溃。恢复流程：

1. 启动时发现 `outbox.tmp` → 视为半条 outbox，直接丢弃；
2. 输入事件幂等追加进 `wal.jsonl`（已记录的跳过）；
3. 从头重放 `wal.jsonl` 重建状态，重新生成输出。

全过程无墙钟依赖，恢复结果与无故障运行**逐字节一致**。
测试可用 `PACK_CRASH_AT=before-rename|after-rename` 注入崩溃（进程以 42 退出）。

## 测试

```sh
node --test
```
