# recon-differ

财务对账差异簇引擎与 CLI。内部流水与银行回单建模为二分依赖图，经匹配规则产生候选边，
按全序（金额差 → 时间窗差 → ID）确定性消解冲突，连通分量即差异簇，簇 ID 为内容哈希
（与事件顺序无关，重算稳定）。仅依赖 Node.js 22 标准库。

## 运行测试

```sh
node --test
```

## CLI

```sh
# 应用 JSONL 事件并输出差异簇 / 调整建议 / 证书（JSONL，stdout）
node bin/recon.js run input.jsonl --state .recon-state
cat input.jsonl | node bin/recon.js run - --state .recon-state

# 从事件日志重算并校验证书
node bin/recon.js verify --state .recon-state
```

输入事件（每行一个 JSON）：

```jsonl
{"type":"internal","id":"I1","amount":100.00,"date":"2026-01-10"}
{"type":"external","id":"E1","amount":100.00,"date":"2026-01-10"}
{"type":"cancel","id":"E1"}
{"type":"rule","version":"v2"}
```

- `external` 同 ID 重发即金额更正；`cancel` 撤销回单并释放内部行，历史匹配保留在审计轨迹中。
- 规则：`v1` 精确（容差 0、窗口 0 天），`v2` 宽松（容差 1.00、窗口 ±3 天）。切换规则触发拓扑级联重算。
- 待人工项状态为 `UNRESOLVED` 并带原因（`no_candidate` / `conflict_lost`），绝不视为不可满足。
- 错误输出到 stderr，退出码 9。

## 持久化与故障点

状态目录含 `events.jsonl`（追加写 + fsync，事实源）与 `clusters.json`（tmp+rename 原子替换的簇索引）。
故障注入：`RECON_FAULT=index-write node bin/recon.js run ...` 模拟写簇索引中途崩溃
（留下部分 tmp、退出码 2）。重启后丢弃残留 tmp、从事件日志重建，簇 ID 由内容派生，不会重复。

## 结构

- `src/engine.js` — 二分图、差分候选维护、全序匹配、簇与建议、证书
- `src/store.js` — 事件日志与原子簇索引、故障注入点
- `src/cli.js` / `bin/recon.js` — 可注入 IO 的 CLI 逻辑与薄封装
- `test/` — 规则切换级联、一对多拒绝、空文件边界、暴力枚举对照、持久化崩溃恢复、撤销/更正
