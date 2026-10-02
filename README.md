# visionline-rework

包装线视觉相机事件流平衡器：按事件流维护 **正品 (good)**、**次品 (defective)**、
**返工在制 (rework)** 三类库存。Node.js 22，仅标准库，测试使用 `node:test`，单机离线。

## 用法

```sh
node cli.js run --stream stream.jsonl --out out
```

输出到 `out/`：

- `state.json` — 最终库存 `{good, defective, rework, pending}`（`pending` 为流结束时仍滞留在
  shutdown 队列中的事件数）
- `moves.jsonl` — 每次库存变动及 shutdown/restart 控制记录，含 `applySeq`（应用序）、
  `seq`（原始流序号）、`delta` 与应用后的库存快照
- `errors.jsonl` — 所有错误记录；存在任何错误时进程退出码为 **2**，合法事件继续处理

## 事件

每行一个 JSON 对象：`{"type": "...", "id": "..."}`（`shutdown`/`restart` 无需 `id`）。

| 事件 | 语义 |
| --- | --- |
| `inspect` | 新判件进入检验（id 唯一，重复报 `duplicate_inspect`） |
| `accept` / `reject` | 判定结果，必须与 `inspect` 配对；**幂等**：重复同结果不改库存；冲突结果报 `conflicting_result`；未配对报 `orphan_accept` / `orphan_reject` |
| `rework_start` | 次品入返工台：`defective-1, rework+1`；重复消费报 `double_consume` |
| `rework_done` | 返工完成：`rework-1, good+1`；重复报 `double_consume` |
| `void_inspect` | 补偿：撤销最近未消费判定（`good-1` 或 `defective-1`）；若已 `rework_start`，**不抹历史**，生成补偿移动 `reverse_rework`（`rework-1`，正品不凭空增加）；若已 `rework_done` 报 `already_consumed` |
| `shutdown` | 之后到达的事件（除 `restart`）进入 pending 队列，不立即生效 |
| `restart` | 恢复运行，pending 事件**按原始到达顺序**汇合，禁止跨重启重排；drain 中再遇 `shutdown` 则剩余事件继续滞留 |

## 错误与退出码

`bad_json`、`invalid_event`、`unknown_event`、`duplicate_inspect`、`orphan_accept`、
`orphan_reject`、`orphan_rework`、`orphan_void`、`conflicting_result`、`double_consume`、
`double_void`、`already_consumed`、`invalid_state`、`invalid_transition`。
任何错误 → 写入 `errors.jsonl` 且 `exit=2`；流不中断。参数/文件错误 → `exit=1`。

## 测试

```sh
node --test
```

- `test/engine.test.js` — 机制单测与验收 2/3/4（重复 reject 后 void 只回滚一次；
  rework_start 后 void 产生 `reverse_rework`；shutdown 期间事件在 restart 后按序生效）
- `test/enumerate.test.js` — 验收 1：长度 ≤5 全枚举（8 种事件，37448 条序列）+
  长度 6–9 种子随机 4000 条（双 id、含 shutdown/restart），与独立 oracle 对照最终三库存，
  并校验库存非负与 `applySeq` 单调
- `test/cli.test.js` — CLI 端到端：输出文件、退出码 0/1/2

试跑示例：`node cli.js run --stream examples/stream.jsonl --out out`
