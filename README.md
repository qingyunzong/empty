# event-trace

边缘网关事件追溯库与 CLI：PLC 报警与质检扫码事件离线缓存，与追溯库双向同步。
目标：**不丢、不重**，且每个批次的锁定原因都可解释、可出证。

仅依赖 Node.js 22 标准库，测试使用 `node:test`，单机离线可运行。

## 事件模型

JSONL，每行一个事件：

```json
{"id":"e1","ts":1700000000000,"device":"PLC1","lot":"L2409","kind":"quality.hold","payload":{"auto":true,"deps":["e0"]}}
```

- `kind`: `quality.hold` / `quality.release` / `quality.scan` / `device.alarm` / `device.clear`
- `payload.deps`: 因果祖先事件 id 列表（happens-before 依据）
- `quality.scan` 且 `payload.result === "fail"` 视为自动超差 hold

## 状态机

- 批次：`normal --hold--> held --release--> normal`
- 设备：`ok --alarm--> alarmed --clear--> ok`
- 非法迁移（如未 hold 先 release）报 `VALIDATION`，事件被拒、状态不变、处理继续

## 冲突判定（happens-before）

同批人工放行与自动超差并发时按因果判定：

- release 因果晚于 hold → 放行生效
- hold 因果晚于 release → 锁定生效
- 二者并发（互不 happens-before）→ **安全优先：held**，记录冲突证书
- 依赖环或未知祖先 → 批次进 **pending**，**不得判失败**；待 sync 补齐祖先后自动解除

## 持久化与故障恢复

存储目录三个文件：`events.log`（追加+fsync）、`index.json`（幂等去重索引，原子写）、
`state.json`（已提交状态，含水位线 `watermark` 与 `appliedSeq`）。

写入流水线：事件落盘 → 索引更新 → 状态 commit。每个阶段前后都是故障注入点
（`EVENT_TRACE_FAILPOINT=before-log,after-log,before-index,after-index,before-commit,after-commit`）。
恢复时按 `appliedSeq` 对账：`seq <= appliedSeq` 已应用跳过；其余重放并补索引 ——
任何故障点崩溃后每个事件**恰好应用一次**。`ingest`/`sync` 前自动先恢复。

乱序窗口 `--window N`（毫秒，默认 5000）：批内按 `(ts, id)` 确定性排序；
早于 `watermark - window` 的迟到事件仍幂等应用并计入 `stats.late`。

## CLI

```sh
event-trace ingest --dir STORE --file events.jsonl [--window 5000]
event-trace sync   --dir STORE --peer OTHER_STORE
event-trace resume --dir STORE
event-trace audit  --dir STORE
event-trace cert   --dir STORE --lot L2409
```

- 正常输出：stdout JSON；诊断：stderr JSON 行
- 退出码：`0` 成功，`2` VALIDATION，`3` STORAGE（持久化/完整性），`4` CONFLICT（存在 pending/冲突）
- `sync` 双向交换事件全集（按 id 去重）后两侧确定性重建，状态收敛一致
- `cert` 输出批次证书：状态、hold/release 清单、因果极大元、happens-before 关系、
  冲突记录与文字解释（为何被锁定）

## 测试

```sh
node --test
```

覆盖：重复与乱序、六个持久化故障点注入恢复（恰好一次）、并发 hold/release 证书、
未知祖先/环进 pending、n≤10 独立参考状态机枚举对照（2046 + 87380 条序列全枚举 +
5000 条定长抽样）、CLI 退出码与 stderr JSON。真实结果见 `RESULTS.md`。
