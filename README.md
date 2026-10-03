# visionline-rework

包装线视觉相机事件流处理器：按事件流平衡 **正品（good）/ 次品（defective）/ 返工（rework）** 三库存。
Node.js 22，仅标准库与 `node:test`，单机离线，无第三方依赖。

## 用法

```sh
node cli.js run --stream stream.jsonl --out out
```

输出到 `out/`：

- `state.json` — 最终三库存、运行状态、各 inspect 状态、未汇合的 pending 事件
- `moves.jsonl` — 每次库存变动/控制标记（含变动后快照与原始 seq，顺序可证）
- `errors.jsonl` — 错误记录；非空时进程退出码为 **2**，合法事件仍继续处理

## 事件格式（stream.jsonl，每行一个 JSON）

| type | 字段 | 语义 |
| --- | --- | --- |
| `inspect` | `id` | 新检测，进入 `pending` |
| `reject` | `id` | 判次品：`defective+1`（须与 inspect 配对，幂等） |
| `accept` | `id` | 判正品：`good+1`（须与 inspect 配对，幂等） |
| `rework_start` | `id` | 开始返工：`defective-1, rework+1` |
| `rework_done` | `id` | 返工完成：`rework-1, good+1` |
| `void_inspect` | `id` | 补偿：撤销最近未消费判定；已返工的生成 `reverse_rework` |
| `shutdown` | — | 停机：后续事件进入 pending 队列 |
| `restart` | — | 重启：pending 按原始到达顺序汇合，禁止跨重启重排 |

## 核心机制

1. **幂等配对**：`reject`/`accept` 必须与 `inspect` 配对；同一 inspect 重复同一判定为幂等空操作（计入 `duplicates`），不改变库存；冲突判定记 `double_consume`。
2. **void 补偿**：`void_inspect` 撤销最近未消费判定（`accepted→good-1`、`rejected→defective-1`，状态变 `voided`）；若已 `rework_start`/`rework_done`，不抹历史，生成 `reverse_rework` 移动把工件退回次品库存，正品不会凭空增加。
3. **停机汇合**：`shutdown` 后到达的事件（除控制事件外）进入 pending；`restart` 后严格按原 seq 顺序汇合，moves 中 seq 单调可证。

## 物品状态机

`pending → accepted | rejected → in_rework → reworked`，补偿边：`accepted/rejected → voided`，`in_rework/reworked → rejected`（reverse_rework）。

## 错误码（errors.jsonl）

`orphan_reject` / `orphan_accept` / `orphan_void` / `orphan_rework_start` / `orphan_rework_done`（无配对 inspect）、
`double_consume`（重复消费/冲突判定）、`invalid_state`（非法状态迁移）、`duplicate_inspect`、`no_verdict`、`missing_id`、`bad_event`、`bad_json`。

## 退出码

`0` 无错误；`2` errors.jsonl 非空（合法事件已继续处理）；`1` 用法/IO 错误。

## 测试

```sh
node --test
```

覆盖验收标准：

1. 长度 ≤9 事件序列的分层穷举（判定/返工全集 + 含 shutdown/restart 的单工件集），每个可达状态校验三库存守恒且非负；
2. 同一 inspect 重复 reject 后 void，只回滚一次；
3. reject→rework_start→void_inspect 产生 `reverse_rework`，正品不凭空增加；
4. shutdown 期间 rework_done 在 restart 后生效，moves seq 顺序可证。
