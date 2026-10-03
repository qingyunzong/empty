# wx-merge — 多站气象订正离线合并

离线合并各气象站的温度订正流：**任意顺序、任意重复**合并后得到同一温度场。
Node.js 22，仅标准库，测试用 `node:test`。

## 模型

- **Key** = `站点 × 时刻`；每个订正事件携带 `(vector, origin, seq)`（向量时钟、来源站、序号）。
- **订正值**可正可负；`|delta| ≤ 15` 为有效，`15 < |delta| ≤ 100` 标记为 `invalid`
  （保留为证据，查询默认过滤），`|delta| > 100` 直接拒绝（`BAD_RANGE`）。
- **删除是 tombstone**：与被删除 key 并发或更早的 put 不能使其复活；
  对已删除 key 的本地写入报 `TOMBSTONE_HIT`。
- **merge** = 事件集并集 + 去重 + compact 水位过滤，天然满足交换律、
  结合律、幂等性（由 ≤8 站点全排列参考验证）。
- **compact** 只在 min vector（各注册站点向量时钟的逐分量最小值）覆盖事件后
  才回收：回收被支配的旧事件与整个 key 被覆盖的 tombstone；可见查询前后等价。
  被保留但处于水位线之下的事件会打上 `pin` 标记，避免后续 merge 被误当作
  过期事件过滤。

## 用法

```bash
# 导入某站订正流（JSONL: {"t": ISO, "delta": 数值} 或 {"t": ISO, "delete": true}，可带 "seq"）
node src/cli.js ingest --store stationA.jsonl --site A --input streamA.jsonl

# 合并任意多个 store（顺序无关）
node src/cli.js merge --out merged.jsonl stationA.jsonl stationB.jsonl stationC.jsonl

# 查询温度场（默认过滤 invalid；--include-invalid 显示证据）
node src/cli.js query --store merged.jsonl [--site A] [--from ISO] [--to ISO] [--include-invalid]

# 压缩（仅回收 min vector 覆盖的事件）
node src/cli.js compact --store merged.jsonl
```

## 错误码

| 代码 | 含义 |
| --- | --- |
| `BAD_RANGE` | 时间无法解析、delta 非有限数、|delta| > 100、非法 seq/vector、非法 JSONL |
| `UNKNOWN_SITE` | 查询指定了未注册的站点 |
| `TOMBSTONE_HIT` | 对已删除（tombstone）的 key 执行写入 |

错误以 `{"error": CODE, "message": ...}` 输出到 stderr，退出码 1。

## 语义保证

- **交换律 / 结合律 / 幂等性**：merge 是事件集上的并集 + 确定性物化，
  由 `test/permutation.test.js` 用 8 站点全排列（40320 种）及随机分组验证。
- **乱序重复 ingest 一致**：重复事件按 `(origin, seq)` 去重，乱序由向量时钟定序。
- **越界订正进入 invalid**：不静默丢弃，`--include-invalid` 可见证据。
- **tombstone 阻止旧站复活**：陈旧副本中的 put 在 merge 后仍被 tombstone 压制。
- **compact 前后可见查询等价**：回收仅发生在 min vector 覆盖之后。

## 限制（离线合并的固有假设）

- 每个站的订正流序号（seq）单调递增；同一 `(origin, seq)` 的事件内容一致。
- compact 回收 tombstone 后，不应再与“分叉早于 compact 水位线”的古老 store
  合并（这是所有 tombstone GC 方案的共同前提；min vector 规则即本系统的
  安全判据）。

## 测试

```bash
node --test   # 全部 21 个测试（含 8 站点全排列参考验证）
```

结果记录见 `RESULTS.md`。
